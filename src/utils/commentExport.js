// Formats the trip comment corpus as Markdown, for pasting into an LLM.
//
// The corpus (see db.js v3) is one flat array of comment-bearing checklists. Both
// callers narrow it first - Build Trip to the localities inside a visit radius,
// Species Map to the checklists mentioning one species - and then hand the
// surviving entries here. This is a deliberately rare, unoptimised path: it runs
// on a few hundred KB of text, on demand, and never during normal page use.

const collator = new Intl.Collator(undefined);

const cleanText = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const formatTime = (value) => {
  const parts = String(value || '').split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : '';
};

export const buildCommentMarkdown = ({
  heading,
  contextLines = [],
  entries,
  locationsById,
  speciesNameByCode,
  onlySpeciesCode = '',
}) => {
  const byLocality = new Map();
  let checklistCount = 0;
  let commentCount = 0;

  for (const entry of entries) {
    const speciesComments = (entry.species_comments || []).filter(
      ([code, text]) => text && (!onlySpeciesCode || code === onlySpeciesCode),
    );
    // A species export carries only that species' notes, so the checklist note is
    // neither shown nor counted there.
    const checklistComment = onlySpeciesCode ? '' : cleanText(entry.checklist_comment);
    if (!speciesComments.length && !checklistComment) continue;

    const localityId = entry.locality_id || '';
    let group = byLocality.get(localityId);
    if (!group) {
      group = { localityId, checklists: [] };
      byLocality.set(localityId, group);
    }
    group.checklists.push({ ...entry, checklistComment, speciesComments });
    checklistCount += 1;
    commentCount += speciesComments.length + (checklistComment ? 1 : 0);
  }

  const groups = Array.from(byLocality.values()).map((group) => {
    const location = locationsById.get(group.localityId);
    return {
      ...group,
      name: location?.locality || group.localityId || 'Unknown location',
      location,
    };
  });
  groups.sort((a, b) => collator.compare(a.name, b.name));

  const lines = [`# ${heading}`, ''];
  for (const line of contextLines) if (line) lines.push(line);
  lines.push(
    `${groups.length} location${groups.length === 1 ? '' : 's'} · ` +
      `${checklistCount} checklist${checklistCount === 1 ? '' : 's'} · ` +
      `${commentCount} comment${commentCount === 1 ? '' : 's'}`,
    '',
  );

  if (!groups.length) {
    lines.push('_No comments recorded._');
    return lines.join('\n');
  }

  for (const group of groups) {
    // Many eBird localities are named after their own coordinates; repeating them
    // in the heading just makes it harder to read.
    const named = !/^\(?-?\d+\.\d+/.test(group.name);
    const coords =
      named && group.location && Number.isFinite(Number(group.location.latitude))
        ? ` (${Number(group.location.latitude).toFixed(4)}, ${Number(group.location.longitude).toFixed(4)})`
        : '';
    lines.push(`## ${group.name}${coords}`);
    lines.push('');

    group.checklists.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

    for (const checklist of group.checklists) {
      const time = formatTime(checklist.time);
      const duration = Number(checklist.duration_minutes);
      const meta = [
        [checklist.date, time].filter(Boolean).join(' '),
        Number.isFinite(duration) && duration > 0 ? `${duration} min` : '',
        checklist.checklist_id ? `https://ebird.org/checklist/${checklist.checklist_id}` : '',
      ].filter(Boolean);
      lines.push(`### ${meta.join(' · ')}`);
      if (checklist.checklistComment) {
        lines.push(`Checklist note: ${checklist.checklistComment}`);
      }
      for (const [code, text] of checklist.speciesComments) {
        lines.push(`- ${speciesNameByCode.get(code) || code}: ${cleanText(text)}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
};

export const downloadMarkdown = (filename, text) => {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const copyMarkdown = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

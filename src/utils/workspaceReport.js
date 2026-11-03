const endpoint = 'https://tripreport.raphaelnussbaumer.com/tripreport-internal/v1/';
export const normalizeWorkspaceReportId = (value) => {
  const match = value.trim().match(/^(?:https:\/\/ebird\.org\/tripreport\/)?(\d+)\/?$/);
  if (!match) throw new Error('Enter an eBird trip report link or numeric ID.');
  return match[1];
};

// Fetch into a fresh snapshot: a failed refresh never replaces the cached report.
export const loadWorkspaceReport = async (
  id,
  { details = false, onProgress = () => {}, signal } = {},
) => {
  const get = async (path) => {
    const response = await fetch(endpoint + path + '/' + id, { signal });
    if (!response.ok) throw new Error(`eBird trip report request failed (${response.status}).`);
    return response.json();
  };
  const [taxa, raw] = await Promise.all([get('taxon-list'), get('checklists')]);
  const checklists = raw.map((c) => ({
    id: c.subId,
    locId: c.locId,
    name: c.loc.name,
    coords: [c.loc.longitude, c.loc.latitude],
    hotspot: c.loc.isHotspot,
    date: c.isoObsDate.replace(' ', 'T'),
    declaredSpecies: c.numSpecies,
    species: {},
  }));
  if (details) {
    const byId = new Map(checklists.map((c) => [c.id, c]));
    let index = 0,
      completed = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, taxa.length) }, async () => {
        while (index < taxa.length) {
          const taxon = taxa[index++];
          const response = await fetch(endpoint + 'taxon-detail/' + id + '/' + taxon.speciesCode, {
            signal,
          });
          if (!response.ok) throw new Error(`Species details request failed (${response.status}).`);
          const detail = await response.json();
          for (const observation of detail.checklists || [])
            if (byId.has(observation.subId))
              byId.get(observation.subId).species[taxon.speciesCode] = observation.howMany ?? 'X';
          onProgress(`${++completed} / ${taxa.length} species loaded`);
        }
      }),
    );
  }
  return { reportId: id, taxa, checklists, updatedAt: Date.now(), details };
};

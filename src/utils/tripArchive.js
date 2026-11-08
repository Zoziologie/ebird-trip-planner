// Compressed files retain the existing JSON format, so older exports still open.
export const encodeTripArchive = async (payload) => {
  const json = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const stream = json.stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' });
};

export const decodeTripArchive = async (file, onProgress = () => {}) => {
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let bytesRead = 0;
  const input = file.stream().pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        onProgress(bytesRead / file.size, 'reading');
        controller.enqueue(chunk);
      },
    }),
  );
  const stream =
    signature[0] === 0x1f && signature[1] === 0x8b
      ? input.pipeThrough(new DecompressionStream('gzip'))
      : input;
  const json = await new Response(stream).text();
  onProgress(1, 'parsing');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(json.replace(/^\uFEFF/, ''));
  if (!payload?.trip?.id) throw new Error('This is not an eBird Trip Planner file.');
  if (payload.version > 3)
    throw new Error(
      'This trip was saved by a newer version of the planner. Update the app to open it.',
    );
  return payload;
};

export const tripArchiveName = (name) =>
  `ebird-trip-${(name || 'trip').replace(/[^a-z0-9_-]+/gi, '-')}.ebirdtrip`;

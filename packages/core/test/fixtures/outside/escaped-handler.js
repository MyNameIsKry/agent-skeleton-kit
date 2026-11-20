// If a loader ever imports this file, path containment is broken.
globalThis.__escapedHandlerImported = true;
export default async function escaped() {
  return { escaped: true };
}

export async function loadXercesEngine(options = {}) {
  const { default: factory } = await import("./xerces-engine.js");
  return factory({
    locateFile: (name) =>
      options.wasmUrl ?? new URL(name, import.meta.url).href,
  });
}

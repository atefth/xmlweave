/** This file runs only in a private worker realm. Never register these callbacks in the host realm. */
const scope = globalThis as any;
let send: (message: any) => void,
  listen: (callback: (message: any) => void) => void;
if (scope.process?.versions?.node) {
  const name = "node:worker_threads";
  const { parentPort } = await import(name);
  send = (message) => parentPort.postMessage(message);
  listen = (callback) => parentPort.on("message", callback);
} else {
  send = (message) => scope.postMessage(message);
  listen = (callback) =>
    (scope.onmessage = (event: any) => callback(event.data));
}
let lib: any,
  validator: any,
  misses: string[] = [],
  graphMetadata: Record<string, any> = {};
function diagnostics(cause: any, phase: string, systemId?: string, max = 100) {
  return (cause?.details ?? [{ message: cause?.message ?? String(cause) }])
    .slice(0, max)
    .map((d: any) => ({
      message: String(d.message).trim(),
      severity: d.level === 1 ? "warning" : d.level === 3 ? "fatal" : "error",
      phase,
      systemId: d.file || systemId,
      ...(phase === "compile" ? graphMetadata[d.file || systemId] : {}),
      ...(d.line > 0 ? { line: d.line } : {}),
      ...(d.col > 0 ? { column: d.col } : {}),
    }));
}
listen!(async (message) => {
  const { id, op } = message;
  if (!Number.isSafeInteger(id) || id < 1) return;
  try {
    if (op === "compile") {
      graphMetadata = message.graph.resourceMetadata ?? {};
      try {
        lib = await import(message.engineURL ?? "libxml2-wasm");
      } catch (cause) {
        throw Object.assign(
          new Error("Could not load the optional libxml2-wasm engine.", {
            cause,
          }),
          { code: "ENGINE_UNAVAILABLE" },
        );
      }
      const encoder = new scope.TextEncoder();
      const data: Record<string, Uint8Array> = Object.create(null);
      for (const [key, value] of Object.entries(message.graph.resources))
        data[key] = encoder.encode(value);
      const provider = new lib.XmlBufferInputProvider(data);
      lib.xmlCleanupInputProvider();
      lib.xmlRegisterInputProvider({
        match: () => true,
        open: (url: string) => {
          if (!Object.hasOwn(data, url)) misses.push(url);
          return provider.open(url);
        },
        read: (fd: number, buffer: Uint8Array) => provider.read(fd, buffer),
        close: (fd: number) => provider.close(fd),
      });
      let doc;
      try {
        doc = lib.XmlDocument.fromString(
          message.graph.resources[message.graph.root],
          {
            url: message.graph.root,
            encoding: "utf-8",
            option:
              lib.ParseOption.XML_PARSE_NO_XXE |
              lib.ParseOption.XML_PARSE_NONET,
          },
        );
        validator = lib.XsdValidator.fromDoc(doc);
        if (misses.length)
          throw Object.assign(
            new Error(
              "Native compiler requested an unresolved schema resource.",
            ),
            { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
          );
      } finally {
        doc?.dispose();
      }
      send!({ id, result: { compiled: true } });
    } else if (op === "validate") {
      if (!validator) throw new Error("No compiled grammar.");
      let doc;
      try {
        doc = lib.XmlDocument.fromString(message.text, {
          url: message.systemId,
          encoding: "utf-8",
          option:
            lib.ParseOption.XML_PARSE_NO_XXE | lib.ParseOption.XML_PARSE_NONET,
        });
        validator.validate(doc);
        send!({ id, result: { valid: true, diagnostics: [] } });
      } catch (cause: any) {
        if (cause instanceof lib.XmlValidateError)
          send!({
            id,
            result: {
              valid: false,
              diagnostics: diagnostics(
                cause,
                "validate",
                message.systemId,
                message.maxDiagnostics ?? 100,
              ),
              ...(cause?.details?.length > (message.maxDiagnostics ?? 100)
                ? { diagnosticsTruncated: true }
                : {}),
            },
          });
        else throw cause;
      } finally {
        doc?.dispose();
      }
    } else if (op === "dispose") {
      validator?.dispose();
      validator = undefined;
      lib?.xmlCleanupInputProvider();
      send!({ id, result: { disposed: true } });
    } else throw new Error("Unknown worker operation.");
  } catch (cause: any) {
    send!({
      id,
      error: {
        code:
          cause?.code ?? (op === "compile" ? "INVALID_SCHEMA" : "ENGINE_ERROR"),
        message: cause?.message ?? String(cause),
        diagnostics: diagnostics(
          cause,
          op === "compile" ? "compile" : "validate",
        ),
      },
    });
  }
});
export {};

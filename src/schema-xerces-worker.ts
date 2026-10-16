import { compileXercesSchema } from "./schema-xerces.js";
import { SchemaError } from "./validation-types.js";
import type { XercesCompiledSchema } from "./schema-xerces.js";
const scope = globalThis as any;
let send: (message: any) => void,
  listen: (callback: (message: any) => void) => void;
if (scope.process?.versions?.node) {
  const moduleName = "node:worker_threads";
  const { parentPort } = await import(moduleName);
  send = (message) => parentPort.postMessage(message);
  listen = (callback) => parentPort.on("message", callback);
} else {
  send = (message) => scope.postMessage(message);
  listen = (callback) =>
    (scope.onmessage = (event: any) => callback(event.data));
}
let grammar: XercesCompiledSchema | undefined,
  current = 0,
  waitingChunk: ((response: any) => void) | undefined,
  waitingAck: (() => void) | undefined;
function errorValue(cause: any) {
  return {
    code: typeof cause?.code === "string" ? cause.code : "ENGINE_ERROR",
    message: cause?.message ?? String(cause),
    diagnostics: cause?.diagnostics ?? [],
  };
}
function diagnosticGate(message: any): (diagnostic: any) => void {
  const control = message.control ? new Int32Array(message.control) : undefined;
  let sequence = 0;
  return (diagnostic) => {
    if (!control) return;
    scope.Atomics.store(control, 0, 0);
    send!({
      id: message.id,
      kind: "handlerDiagnostic",
      sequence: ++sequence,
      diagnostic,
    });
    while (scope.Atomics.load(control, 0) === 0)
      scope.Atomics.wait(control, 0, 0);
    if (scope.Atomics.load(control, 0) !== 1)
      throw new SchemaError(
        message.kind === "compile" ? "INVALID_SCHEMA" : "INVALID_XML",
        "Fatal XML diagnostic terminates validation.",
        [diagnostic],
      );
  };
}
async function validate(message: any) {
  const id = message.id;
  current = id;
  const chunks: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            waitingChunk = resolve;
            send!({ id, kind: "needChunk" });
          }),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
  try {
    for await (const event of grammar!.validateStream(chunks, {
      ...message.options,
      onDiagnostic: message.control ? diagnosticGate(message) : undefined,
    })) {
      await new Promise<void>((resolve) => {
        waitingAck = resolve;
        send!({ id, kind: "event", event });
      });
    }
    send!({ id, kind: "complete" });
  } catch (cause) {
    send!({ id, kind: "failure", error: errorValue(cause) });
  } finally {
    current = 0;
    waitingChunk = undefined;
    waitingAck = undefined;
  }
}
listen!((message) => {
  if (!Number.isSafeInteger(message?.id) || message.id < 1) return;
  if (message.kind === "chunk" && message.id === current) {
    const receive = waitingChunk;
    waitingChunk = undefined;
    receive?.(
      message.done ? { done: true } : { done: false, value: message.text },
    );
    return;
  }
  if (message.kind === "inputError" && message.id === current) {
    const receive = waitingChunk;
    waitingChunk = undefined;
    receive?.({ done: false, value: undefined });
    return;
  }
  if (message.kind === "ack" && message.id === current) {
    const receive = waitingAck;
    waitingAck = undefined;
    receive?.();
    return;
  }
  if (message.kind === "compile") {
    void (async () => {
      try {
        const { graph } = message;
        const ordered = [
          graph.root,
          ...Object.keys(graph.resources).filter((id) => id !== graph.root),
        ];
        const gate = diagnosticGate(message);
        let diagnostics = 0;
        const metadata = (diagnostic: any) => ({
          ...diagnostic,
          ...graph.resourceMetadata?.[diagnostic.systemId],
        });
        grammar = await compileXercesSchema(
          ordered.map((id) => ({
            kind: "text",
            text: graph.resources[id],
            systemId: id,
          })),
          {
            ...message.options,
            onDiagnostic: (diagnostic) => {
              diagnostic = metadata(diagnostic);
              gate(diagnostic);
              if (++diagnostics <= (message.options.maxDiagnostics ?? 100))
                send!({
                  id: message.id,
                  kind: "compileDiagnostic",
                  diagnostic,
                });
            },
          },
        );
        send!({ id: message.id, kind: "compiled" });
      } catch (cause) {
        const error = errorValue(cause);
        error.diagnostics = error.diagnostics.map((diagnostic: any) => ({
          ...diagnostic,
          ...message.graph.resourceMetadata?.[diagnostic.systemId],
        }));
        send!({ id: message.id, kind: "failure", error });
      }
    })();
  } else if (message.kind === "queryTypeDerivation" && grammar && !current) {
    current = message.id;
    void (async () => {
      try {
        const query = (
          grammar as unknown as {
            queryTypeDerivation(
              typeIdentity: any,
              ancestor: any,
              method: number,
            ): Promise<boolean>;
          }
        ).queryTypeDerivation;
        const result = await query.call(
          grammar,
          message.typeIdentity,
          message.ancestor,
          message.method,
        );
        send!({ id: message.id, kind: "typeDerivation", result });
      } catch (cause) {
        send!({ id: message.id, kind: "failure", error: errorValue(cause) });
      } finally {
        current = 0;
      }
    })();
  } else if (message.kind === "validate" && grammar && !current)
    void validate(message);
});

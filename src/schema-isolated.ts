import {
  prepareSchemaGraph,
  inspectInstance,
  readInstanceSchemaHints,
} from "./schema-graph.js";
import type { SchemaGraphOptions, InstanceSchemaHint } from "./schema-graph.js";
import { normalizeSchemaSource } from "./schema-sources.js";
import { SchemaError } from "./validation-types.js";
import type {
  SchemaSource,
  SchemaOptions,
  SchemaValidationResult,
} from "./validation-types.js";
import type { WorkerTransport } from "./vendor-worker-node.js";
export { SchemaError } from "./validation-types.js";
export type {
  SchemaResourceRequest,
  SchemaGraphOptions,
} from "./schema-graph.js";
export interface IsolatedSchemaOptions extends SchemaGraphOptions {
  workerURL?: string;
  engineURL?: string;
  timeoutMs?: number;
  maxQueue?: number;
}
export interface IsolatedValidationOptions extends SchemaOptions {
  timeoutMs?: number;
}
export interface IsolatedCompiledSchema {
  readonly disposed: boolean;
  readonly sourceIds: readonly string[];
  readonly capabilities: Readonly<{
    composition: true;
    hardTimeout: true;
    nativeWarnings: false;
    streaming: false;
  }>;
  validate(
    source: SchemaSource,
    options?: IsolatedValidationOptions,
  ): Promise<SchemaValidationResult>;
  dispose(): void;
}
const scope = globalThis as any;
function number(
  value: number | undefined,
  fallback: number,
  max: number,
  name: string,
) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new SchemaError(
      "INVALID_ARGUMENT",
      `${name} is outside its supported range.`,
    );
  return value;
}
async function worker(
  options: IsolatedSchemaOptions,
): Promise<WorkerTransport> {
  if (scope.process?.versions?.node) {
    const factory = await import("./vendor-worker-node.js");
    return factory.createNodeSchemaWorker(options.workerURL);
  }
  if (!options.workerURL || !options.engineURL)
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Browser workers require explicit workerURL and engineURL (worker realms do not inherit import maps).",
    );
  const native = new scope.Worker(options.workerURL, { type: "module" });
  return {
    postMessage: (message) => native.postMessage(message),
    terminate: () => native.terminate(),
    listen: (message, error) => {
      native.onmessage = (event: any) => message(event.data);
      native.onerror = error;
    },
  };
}
/** Compile an explicit, bounded XSD graph in its own disposable WASM worker. */
export async function compileIsolatedSchema(
  source: SchemaSource | readonly SchemaSource[],
  options: IsolatedSchemaOptions = {},
): Promise<IsolatedCompiledSchema> {
  return compileIsolatedSchemaInternal(source, options);
}
async function compileIsolatedSchemaInternal(
  source: SchemaSource | readonly SchemaSource[],
  options: IsolatedSchemaOptions,
  approvedHints?: readonly InstanceSchemaHint[],
): Promise<IsolatedCompiledSchema> {
  const timeout = number(options.timeoutMs, 30_000, 3_600_000, "timeoutMs"),
    maxQueue = number(options.maxQueue, 64, 1024, "maxQueue");
  if (options.signal?.aborted)
    throw new SchemaError("ABORTED", "Schema operation was aborted.");
  const graph = await prepareSchemaGraph(source, options);
  const transport = await worker(options);
  let disposed = false,
    nextId = 0,
    queued = 0;
  let tail = Promise.resolve();
  const pending = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (cause: unknown) => void;
      timer: any;
      poll: any;
    }
  >();
  function stop(cause: SchemaError) {
    if (disposed) return;
    disposed = true;
    transport.terminate();
    for (const request of pending.values()) {
      scope.clearTimeout(request.timer);
      scope.clearInterval(request.poll);
      request.reject(cause);
    }
    pending.clear();
  }
  transport.listen(
    (message) => {
      const request = pending.get(message?.id);
      if (!request) return;
      pending.delete(message.id);
      scope.clearTimeout(request.timer);
      scope.clearInterval(request.poll);
      if (message.error)
        request.reject(
          new SchemaError(
            message.error.code,
            message.error.message,
            message.error.diagnostics,
          ),
        );
      else request.resolve(message.result);
    },
    (cause) =>
      stop(new SchemaError("ENGINE_ERROR", "Schema worker failed.", [], cause)),
  );
  function request(
    op: string,
    payload: any,
    operationOptions: IsolatedValidationOptions = {},
  ): Promise<any> {
    if (disposed)
      return Promise.reject(
        new SchemaError("DISPOSED", "The isolated schema has been disposed."),
      );
    if (operationOptions.signal?.aborted)
      return Promise.reject(
        new SchemaError("ABORTED", "Schema operation was aborted."),
      );
    if (queued >= maxQueue)
      return Promise.reject(
        new SchemaError("RESOURCE_LIMIT", "Schema operation queue is full."),
      );
    const deadline = number(
      operationOptions.timeoutMs,
      timeout,
      3_600_000,
      "timeoutMs",
    );
    queued++;
    const run = tail.then(
      () =>
        new Promise((resolve, reject) => {
          if (disposed) {
            reject(
              new SchemaError(
                "DISPOSED",
                "The isolated schema has been disposed.",
              ),
            );
            return;
          }
          if (operationOptions.signal?.aborted) {
            reject(new SchemaError("ABORTED", "Schema operation was aborted."));
            return;
          }
          const id = ++nextId;
          const timer = scope.setTimeout(
            () =>
              stop(
                new SchemaError(
                  "TIMEOUT",
                  "Schema worker deadline exceeded; the compiled handle is invalidated.",
                ),
              ),
            deadline,
          );
          const poll = operationOptions.signal
            ? scope.setInterval(() => {
                if (operationOptions.signal?.aborted)
                  stop(
                    new SchemaError(
                      "ABORTED",
                      "Schema worker was aborted; the compiled handle is invalidated.",
                    ),
                  );
              }, 5)
            : undefined;
          pending.set(id, { resolve, reject, timer, poll });
          transport.postMessage({ id, op, ...payload });
        }),
    );
    tail = run.then(
      () => {},
      () => {},
    );
    return run.finally(() => queued--);
  }
  try {
    await request(
      "compile",
      { graph, engineURL: options.engineURL },
      { signal: options.signal },
    );
  } catch (cause) {
    stop(new SchemaError("DISPOSED", "Schema compilation failed."));
    throw cause;
  }
  return {
    get disposed() {
      return disposed;
    },
    sourceIds: graph.sourceIds,
    capabilities: Object.freeze({
      composition: true,
      hardTimeout: true,
      nativeWarnings: false,
      streaming: false,
    }),
    async validate(input, validationOptions = {}) {
      if (disposed)
        throw new SchemaError(
          "DISPOSED",
          "The isolated schema has been disposed.",
        );
      const normalized = await normalizeSchemaSource(input, validationOptions);
      try {
        inspectInstance(normalized.text, approvedHints, normalized.systemId);
      } catch (cause) {
        if (cause instanceof SchemaError) throw cause;
        throw new SchemaError(
          "INVALID_XML",
          "Expected safe well-formed XML.",
          [],
          cause,
        );
      }
      const result: SchemaValidationResult = await request(
        "validate",
        {
          text: normalized.text,
          systemId: normalized.systemId,
          maxDiagnostics: number(
            validationOptions.maxDiagnostics,
            100,
            10000,
            "maxDiagnostics",
          ),
        },
        validationOptions,
      );
      const max = number(
        validationOptions.maxDiagnostics,
        100,
        10000,
        "maxDiagnostics",
      );
      if (result.diagnostics.length > max) {
        result.diagnostics = result.diagnostics.slice(0, max);
        result.diagnosticsTruncated = true;
      }
      for (const diagnostic of result.diagnostics)
        validationOptions.onDiagnostic?.(Object.freeze({ ...diagnostic }));
      if (!result.valid && validationOptions.errorPolicy === "throw")
        throw new SchemaError(
          "INVALID_XML",
          "XML does not conform to the compiled schema.",
          result.diagnostics,
        );
      return result;
    },
    dispose() {
      stop(
        new SchemaError("DISPOSED", "The isolated schema has been disposed."),
      );
    },
  };
}

/** Opt-in hint compilation. Hints are identifiers, never transport instructions. */
export async function compileIsolatedSchemaFromHints(
  instance: SchemaSource,
  options: IsolatedSchemaOptions = {},
): Promise<IsolatedCompiledSchema> {
  const input = await normalizeSchemaSource(instance, options);
  const hints = readInstanceSchemaHints(input.text, input.systemId);
  inspectInstance(input.text, hints, input.systemId);
  const resources: Record<string, SchemaSource> = { ...options.resourceMap };
  for (const hint of hints) {
    let resolved: SchemaSource | undefined = resources[hint.uri];
    if (!resolved && options.resolver)
      resolved = await options.resolver(
        Object.freeze({
          kind: "hint",
          namespace: hint.namespace,
          systemId: hint.location,
          baseURI: input.systemId ?? "https://xmlweave.invalid/instance.xml",
          requestedURI: hint.uri,
        }),
      );
    if (!resolved)
      throw new SchemaError(
        "EXTERNAL_RESOURCE_FORBIDDEN",
        `No explicit resource for instance schema hint ${hint.uri}.`,
      );
    resources[hint.uri] = resolved;
  }
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const root = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">${hints.map((hint) => (hint.namespace ? `<xs:import namespace="${escape(hint.namespace)}" schemaLocation="${escape(hint.uri)}"/>` : `<xs:include schemaLocation="${escape(hint.uri)}"/>`)).join("")}</xs:schema>`;
  return compileIsolatedSchemaInternal(
    {
      kind: "text",
      text: root,
      systemId: "https://xmlweave.invalid/hint-entry.xsd",
    },
    { ...options, resourceMap: resources },
    hints,
  );
}

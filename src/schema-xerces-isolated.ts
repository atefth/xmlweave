import {
  markNormalizedTransport,
  getNormalizedTransport,
} from "./validation-types.js";
import {
  normalizeSourceWithDeadline,
  withinSourceDeadline,
  remainingSourceTimeout,
} from "./source-deadline.js";
import { prepareSchemaGraph } from "./schema-graph.js";
import type { SchemaGraphOptions } from "./schema-graph.js";
import { normalizeSchemaSource, sourceLimits } from "./schema-sources.js";
import { SchemaError } from "./validation-types.js";
import type {
  SchemaOptions,
  SchemaSource,
  SchemaDiagnostic,
  SchemaValidationResult,
  SchemaSignal,
} from "./validation-types.js";
import type {
  XercesValidationEvent,
  XercesDerivationQuery,
  XercesFeatures,
} from "./schema-xerces.js";
import type { XercesWorkerTransport } from "./vendor-xerces-worker-node.js";
export { SchemaError } from "./validation-types.js";
export type {
  XercesValidationEvent,
  XercesPSVI,
  XercesTypeInfo,
  XercesAttribute,
} from "./schema-xerces.js";
export type IsolatedDiagnosticHandler = (
  diagnostic: Readonly<SchemaDiagnostic>,
) => void | Promise<void>;
export interface IsolatedXercesOptions
  extends SchemaGraphOptions,
    SchemaOptions {
  workerURL?: string;
  wasmUrl?: string;
  timeoutMs?: number;
  typeQueries?: readonly XercesDerivationQuery[];
  features?: XercesFeatures;
  diagnosticHandler?: IsolatedDiagnosticHandler;
}
export interface IsolatedXercesOperationOptions extends SchemaOptions {
  timeoutMs?: number;
  systemId?: string;
  diagnosticHandler?: IsolatedDiagnosticHandler;
}
export interface IsolatedXercesTypeName {
  readonly namespaceURI: string;
  readonly name: string;
}
export interface IsolatedXercesTypeIdentity extends IsolatedXercesTypeName {
  readonly schemaIdentity: string;
}
export interface IsolatedXercesQueryOptions {
  signal?: SchemaSignal;
  timeoutMs?: number;
}
export interface IsolatedXercesSchema {
  readonly disposed: boolean;
  readonly busy: boolean;
  queryTypeDerivation(
    typeIdentity: IsolatedXercesTypeIdentity,
    ancestor: IsolatedXercesTypeName,
    method?: number,
    options?: IsolatedXercesQueryOptions,
  ): Promise<boolean>;
  validate(
    source: SchemaSource,
    options?: IsolatedXercesOperationOptions,
  ): Promise<SchemaValidationResult>;
  validateStream(
    chunks: AsyncIterable<string> | Iterable<string>,
    options?: IsolatedXercesOperationOptions,
  ): AsyncIterable<XercesValidationEvent>;
  dispose(): void;
}
const runtime = globalThis as any;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function checked(options: IsolatedXercesOptions, operation = false): void {
  sourceLimits(options);
  if (options.diagnosticHandler !== undefined) {
    if (typeof options.diagnosticHandler !== "function")
      throw new SchemaError(
        "INVALID_ARGUMENT",
        "diagnosticHandler must be a function.",
      );
    if (
      typeof runtime.SharedArrayBuffer !== "function" ||
      !runtime.Atomics ||
      (!runtime.process?.versions?.node && runtime.crossOriginIsolated !== true)
    )
      throw new SchemaError(
        "UNSUPPORTED_CAPABILITY",
        "Exact diagnostic handlers require SharedArrayBuffer and, in browsers, cross-origin isolation (COOP/COEP).",
      );
  }
  const allowed = [
    "signal",
    "maxBytes",
    "maxCharacters",
    "maxDiagnostics",
    "onDiagnostic",
    "diagnosticHandler",
    "errorPolicy",
    "timeoutMs",
    ...(operation
      ? ["systemId"]
      : [
          "workerURL",
          "wasmUrl",
          "typeQueries",
          "features",
          "resourceMap",
          "namespaceCatalog",
          "resolver",
          "maxDocuments",
          "maxGraphDepth",
          "maxGraphBytes",
          "maxRequests",
        ]),
  ];
  for (const name of Object.keys(options))
    if (!allowed.includes(name))
      throw new SchemaError(
        "INVALID_ARGUMENT",
        `Unsupported isolated Xerces option: ${name}.`,
      );
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 3600000)
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "timeoutMs must be an integer from 1 to 3600000.",
    );
  if (
    options.maxDiagnostics !== undefined &&
    (!Number.isSafeInteger(options.maxDiagnostics) ||
      options.maxDiagnostics < 1 ||
      options.maxDiagnostics > 10000)
  )
    throw new SchemaError("INVALID_ARGUMENT", "Invalid diagnostic budget.");
  if (
    "systemId" in options &&
    options.systemId !== undefined &&
    typeof options.systemId !== "string"
  )
    throw new SchemaError("INVALID_ARGUMENT", "systemId must be a string.");
  if (
    options.workerURL !== undefined &&
    (typeof options.workerURL !== "string" || !options.workerURL)
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "workerURL must be a nonempty string.",
    );
  if (
    options.features !== undefined &&
    (!options.features ||
      typeof options.features !== "object" ||
      Array.isArray(options.features) ||
      Object.entries(options.features).some(
        ([key, value]) =>
          ![
            "fullSchemaChecking",
            "identityConstraints",
            "multipleImports",
          ].includes(key) || typeof value !== "boolean",
      ))
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Invalid native feature settings.",
    );
  if (
    options.wasmUrl !== undefined &&
    (typeof options.wasmUrl !== "string" || !options.wasmUrl)
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "wasmUrl must be a nonempty string.",
    );
  if (
    options.onDiagnostic !== undefined &&
    typeof options.onDiagnostic !== "function"
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "onDiagnostic must be a function.",
    );
  if (
    options.errorPolicy !== undefined &&
    !["result", "throw"].includes(options.errorPolicy)
  )
    throw new SchemaError("INVALID_ARGUMENT", "Unsupported errorPolicy.");
}
async function createWorker(
  options: IsolatedXercesOptions,
): Promise<XercesWorkerTransport> {
  if (runtime.process?.versions?.node)
    return (await import("./vendor-xerces-worker-node.js")).createXercesWorker(
      options.workerURL,
    );
  if (!options.workerURL)
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Browser isolation requires an explicit workerURL.",
    );
  const worker = new runtime.Worker(options.workerURL, { type: "module" });
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
    listen: (message, error) => {
      worker.onmessage = (event: any) => message(event.data);
      worker.onerror = error;
    },
  };
}
/** A separate native WASM realm per compiled grammar, with pull-driven input and acknowledged output. */
export async function compileIsolatedXercesSchema(
  source: SchemaSource | readonly SchemaSource[],
  options: IsolatedXercesOptions = {},
): Promise<IsolatedXercesSchema> {
  const started = Date.now();
  checked(options);
  if (
    options.typeQueries !== undefined &&
    (!Array.isArray(options.typeQueries) ||
      options.typeQueries.length > 256 ||
      options.typeQueries.some(
        (q) =>
          !q ||
          typeof q.name !== "string" ||
          typeof q.namespaceURI !== "string" ||
          !Number.isInteger(q.method ?? 0) ||
          (q.method ?? 0) < 0 ||
          (q.method ?? 0) > 15,
      ))
  )
    throw new SchemaError("INVALID_ARGUMENT", "Invalid derivation queries.");
  options = {
    ...options,
    typeQueries: options.typeQueries?.map((q) => ({ ...q })),
    features: options.features ? { ...options.features } : undefined,
  };
  if (options.signal?.aborted)
    throw new SchemaError("ABORTED", "Schema compilation was aborted.");
  const graph = await withinSourceDeadline(
    (signal) => prepareSchemaGraph(source, { ...options, signal }),
    options,
  );
  if (options.signal?.aborted)
    throw new SchemaError("ABORTED", "Schema compilation was aborted.");
  const worker = await createWorker(options);
  let disposed = false,
    busy = false,
    nextId = 0,
    activeId = 0,
    terminal: unknown;
  let receive: ((message: any) => void) | undefined,
    rejectReceive: ((cause: unknown) => void) | undefined;
  const messages: any[] = [];
  let closeInput: (() => void) | undefined;
  let activeHandler: IsolatedDiagnosticHandler | undefined,
    activeControl: Int32Array | undefined,
    handlerSequence = 0;
  let handlerProvenance: Record<string, string> | undefined;
  function controlFor(
    handler: IsolatedDiagnosticHandler | undefined,
  ): Int32Array | undefined {
    return handler
      ? new Int32Array(new runtime.SharedArrayBuffer(4))
      : undefined;
  }
  function handleDiagnostic(message: any) {
    const handler = activeHandler,
      control = activeControl,
      id = activeId;
    if (
      !handler ||
      !control ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence !== handlerSequence + 1
    ) {
      stop(
        new SchemaError(
          "ENGINE_ERROR",
          "Invalid diagnostic decision protocol.",
        ),
      );
      return;
    }
    handlerSequence = message.sequence;
    const diagnostic = freeze({ ...message.diagnostic, ...handlerProvenance });
    void Promise.resolve()
      .then(() => handler(diagnostic))
      .then(
        () => {
          if (disposed || activeId !== id || activeControl !== control) return;
          runtime.Atomics.store(
            control,
            0,
            diagnostic.severity === "fatal" ? 2 : 1,
          );
          runtime.Atomics.notify(control, 0, 1);
        },
        (cause) => stop(cause),
      );
  }
  function stop(cause: unknown) {
    if (disposed) return;
    disposed = true;
    busy = false;
    terminal = cause;
    worker.terminate();
    try {
      closeInput?.();
    } catch {}
    rejectReceive?.(cause);
    receive = undefined;
    rejectReceive = undefined;
    messages.length = 0;
  }
  worker.listen(
    (message) => {
      if (disposed || message?.id !== activeId) return;
      if (message.kind === "handlerDiagnostic") {
        handleDiagnostic(message);
        return;
      }
      if (receive) {
        const next = receive;
        receive = undefined;
        rejectReceive = undefined;
        next(message);
      } else {
        if (messages.length >= 2) {
          stop(
            new SchemaError(
              "ENGINE_ERROR",
              "Worker exceeded the bounded message protocol.",
            ),
          );
          return;
        }
        messages.push(message);
      }
    },
    (cause) =>
      stop(
        new SchemaError(
          "ENGINE_ERROR",
          "Isolated Xerces worker failed.",
          [],
          cause,
        ),
      ),
  );
  function next(): Promise<any> {
    if (disposed) return Promise.reject(terminal);
    if (messages.length) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      receive = resolve;
      rejectReceive = reject;
    });
  }
  function budgets(config: IsolatedXercesOptions) {
    const timer = runtime.setTimeout(
      () =>
        stop(
          new SchemaError(
            "TIMEOUT",
            "Xerces worker deadline exceeded; the grammar is invalidated.",
          ),
        ),
      config.timeoutMs ?? 30000,
    );
    const poll = config.signal
      ? runtime.setInterval(() => {
          if (config.signal?.aborted)
            stop(
              new SchemaError(
                "ABORTED",
                "Xerces worker was aborted; the grammar is invalidated.",
              ),
            );
        }, 5)
      : undefined;
    return () => {
      runtime.clearTimeout(timer);
      runtime.clearInterval(poll);
    };
  }
  activeId = ++nextId;
  activeHandler = options.diagnosticHandler;
  activeControl = controlFor(activeHandler);
  handlerSequence = 0;
  let finishCompile = () => {};
  try {
    finishCompile = budgets({
      ...options,
      timeoutMs: remainingSourceTimeout(options.timeoutMs, started),
    });
    worker.postMessage({
      kind: "compile",
      id: activeId,
      graph,
      control: activeControl?.buffer,
      options: {
        wasmUrl: options.wasmUrl,
        typeQueries: options.typeQueries,
        features: options.features,
        maxCharacters: options.maxCharacters,
        maxBytes: 4000000,
        maxDiagnostics: options.maxDiagnostics,
      },
    });
    while (true) {
      const message = await next();
      if (message.kind === "compiled") break;
      if (message.kind === "compileDiagnostic")
        options.onDiagnostic?.(freeze(message.diagnostic));
      else if (message.kind === "failure")
        throw new SchemaError(
          message.error.code,
          message.error.message,
          message.error.diagnostics,
        );
      else
        throw new SchemaError(
          "ENGINE_ERROR",
          "Unexpected compiler protocol message.",
        );
    }
  } catch (cause) {
    stop(cause);
    throw cause;
  } finally {
    finishCompile();
  }
  options = {
    ...options,
    signal: undefined,
    onDiagnostic: undefined,
    diagnosticHandler: undefined,
    errorPolicy: undefined,
  };
  activeHandler = undefined;
  activeControl = undefined;
  const handle: IsolatedXercesSchema = {
    get disposed() {
      return disposed;
    },
    get busy() {
      return busy;
    },
    dispose() {
      stop(
        new SchemaError(
          "DISPOSED",
          "The isolated Xerces grammar has been disposed.",
        ),
      );
    },
    async queryTypeDerivation(
      typeIdentity,
      ancestor,
      method = 0,
      queryOptions = {},
    ) {
      if (disposed)
        throw new SchemaError(
          "DISPOSED",
          "The isolated Xerces grammar has been disposed.",
        );
      if (busy)
        throw new SchemaError(
          "BUSY",
          "The isolated Xerces grammar is already active.",
        );
      checked(queryOptions, true);
      if (
        Object.keys(queryOptions).some(
          (key) => !["signal", "timeoutMs"].includes(key),
        )
      )
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Type queries accept only signal and timeoutMs.",
        );
      for (const identity of [typeIdentity, ancestor])
        if (
          !identity ||
          typeof identity !== "object" ||
          Array.isArray(identity) ||
          typeof identity.name !== "string" ||
          !identity.name ||
          typeof identity.namespaceURI !== "string"
        )
          throw new SchemaError(
            "INVALID_ARGUMENT",
            "Type identities require a name and namespaceURI.",
          );
      if (
        typeof typeIdentity.schemaIdentity !== "string" ||
        !typeIdentity.schemaIdentity
      )
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Type identities require their owning schemaIdentity.",
        );
      if (!Number.isInteger(method) || method < 0 || method > 15)
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Derivation method must be a mask from 0 to 15.",
        );
      if (queryOptions.signal?.aborted)
        throw new SchemaError("ABORTED", "Type query was aborted.");
      busy = true;
      activeId = ++nextId;
      const id = activeId;
      activeHandler = undefined;
      activeControl = undefined;
      handlerProvenance = undefined;
      let remoteFailure = false;
      const finish = budgets({
        timeoutMs: options.timeoutMs,
        ...Object.fromEntries(
          Object.entries(queryOptions).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      });
      try {
        worker.postMessage({
          kind: "queryTypeDerivation",
          id,
          typeIdentity: { ...typeIdentity },
          ancestor: { ...ancestor },
          method,
        });
        const response = await next();
        if (response.kind === "failure") {
          remoteFailure = [
            "INVALID_ARGUMENT",
            "UNSUPPORTED_CAPABILITY",
          ].includes(response.error.code);
          throw new SchemaError(
            response.error.code,
            response.error.message,
            response.error.diagnostics,
          );
        }
        if (
          response.kind !== "typeDerivation" ||
          typeof response.result !== "boolean"
        )
          throw new SchemaError(
            "ENGINE_ERROR",
            "Unexpected type-query response.",
          );
        return response.result;
      } catch (cause) {
        if (!remoteFailure && !disposed) stop(cause);
        throw cause;
      } finally {
        finish();
        busy = false;
      }
    },
    async validate(input, operation = {}) {
      if (disposed)
        throw new SchemaError(
          "DISPOSED",
          "The isolated Xerces grammar has been disposed.",
        );
      checked(operation, true);
      operation = Object.fromEntries(
        Object.entries(operation).filter(([, value]) => value !== undefined),
      );
      const started = Date.now();
      for (const key of [
        "maxCharacters",
        "maxBytes",
        "maxDiagnostics",
      ] as const)
        if (
          options[key] !== undefined &&
          operation[key] !== undefined &&
          operation[key]! > options[key]!
        )
          throw new SchemaError(
            "INVALID_ARGUMENT",
            `${key} cannot exceed the inherited safety limit.`,
          );
      const normalized = await normalizeSourceWithDeadline(
        input,
        {
          timeoutMs: options.timeoutMs,
          maxCharacters: options.maxCharacters,
          maxBytes: options.maxBytes,
          ...operation,
        },
        () => disposed,
      );
      let result: SchemaValidationResult | undefined;
      const chunks = [normalized.text];
      markNormalizedTransport(chunks, {
        sourceKind: normalized.sourceKind,
        provenance: normalized.provenance,
      });
      for await (const event of handle.validateStream(chunks, {
        ...operation,
        systemId: normalized.systemId,
        timeoutMs: remainingSourceTimeout(
          operation.timeoutMs ?? options.timeoutMs,
          started,
        ),
      }))
        if (event.kind === "result") result = event.result;
      return result!;
    },
    async *validateStream(chunks, operation = {}) {
      if (disposed)
        throw new SchemaError(
          "DISPOSED",
          "The isolated Xerces grammar has been disposed.",
        );
      if (busy)
        throw new SchemaError(
          "BUSY",
          "The isolated Xerces grammar is already validating.",
        );
      checked(operation, true);
      operation = Object.fromEntries(
        Object.entries(operation).filter(([, value]) => value !== undefined),
      );
      for (const key of [
        "maxCharacters",
        "maxBytes",
        "maxDiagnostics",
      ] as const)
        if (
          options[key] !== undefined &&
          operation[key] !== undefined &&
          operation[key]! > options[key]!
        )
          throw new SchemaError(
            "INVALID_ARGUMENT",
            `${key} cannot exceed the inherited safety limit.`,
          );
      const config = {
        ...options,
        ...operation,
        onDiagnostic: operation.onDiagnostic,
        diagnosticHandler: operation.diagnosticHandler,
      };
      if (config.signal?.aborted)
        throw new SchemaError("ABORTED", "Validation was aborted.");
      let input: AsyncIterator<string> | Iterator<string>;
      try {
        const factory =
          (chunks && (chunks as AsyncIterable<string>)[Symbol.asyncIterator]) ||
          (chunks && (chunks as Iterable<string>)[Symbol.iterator]);
        if (typeof factory !== "function") throw new Error();
        input = factory.call(chunks);
        if (!input || typeof input.next !== "function") throw new Error();
      } catch (cause) {
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Streaming input must provide an iterator.",
          [],
          cause,
        );
      }
      const normalizedMetadata = getNormalizedTransport(
        chunks as object,
        sourceLimits(config).maxBytes,
      );
      const provenance = {
        sourceKind: normalizedMetadata?.sourceKind ?? "chunks",
        provenance: normalizedMetadata?.provenance ?? "original",
      };
      let inputCharacters = 0;
      const inputLimits = sourceLimits(config);
      busy = true;
      activeId = ++nextId;
      const id = activeId;
      activeHandler = config.diagnosticHandler;
      activeControl = controlFor(activeHandler);
      handlerSequence = 0;
      handlerProvenance = provenance;
      let complete = false,
        resultSeen = false,
        awaitingAck = false,
        pulling = false;
      let invalidError: SchemaError | undefined;
      let inputClosed = false;
      closeInput = () => {
        if (inputClosed) return;
        inputClosed = true;
        try {
          void Promise.resolve(input.return?.()).catch(() => {});
        } catch {}
      };
      const finish = budgets(config);
      const pull = () => {
        if (pulling) {
          stop(
            new SchemaError(
              "ENGINE_ERROR",
              "Worker requested overlapping input reads.",
            ),
          );
          return;
        }
        pulling = true;
        void Promise.resolve()
          .then(() => input.next())
          .then(
            (response) => {
              pulling = false;
              if (disposed || activeId !== id) return;
              if (!response || typeof response !== "object")
                throw new SchemaError(
                  "INVALID_ARGUMENT",
                  "Input iterator returned an invalid result.",
                );
              if (!response.done && typeof response.value !== "string")
                throw new SchemaError(
                  "INVALID_ARGUMENT",
                  "Streaming input must contain strings.",
                );
              if (!response.done) {
                inputCharacters += response.value.length;
                if (inputCharacters > inputLimits.maxCharacters)
                  throw new SchemaError(
                    "RESOURCE_LIMIT",
                    "Streaming input character limit exceeded.",
                  );
              }
              worker.postMessage({
                kind: "chunk",
                id,
                done: !!response.done,
                text: response.value,
              });
            },
            (cause) => {
              pulling = false;
              stop(cause);
            },
          )
          .catch((cause) => stop(cause));
      };
      try {
        worker.postMessage({
          kind: "validate",
          id,
          control: activeControl?.buffer,
          options: {
            systemId: operation.systemId,
            maxCharacters: config.maxCharacters,
            maxBytes:
              getNormalizedTransport(chunks as object) !== undefined
                ? 4000000
                : config.maxBytes,
            maxDiagnostics: config.maxDiagnostics,
            errorPolicy: "result",
          },
        });
        while (true) {
          const message = await next();
          if (message.kind === "needChunk") {
            pull();
            continue;
          }
          if (message.kind === "failure")
            throw new SchemaError(
              message.error.code,
              message.error.message,
              message.error.diagnostics,
            );
          if (message.kind === "complete") {
            complete = true;
            if (invalidError) throw invalidError;
            break;
          }
          if (message.kind !== "event")
            throw new SchemaError(
              "ENGINE_ERROR",
              "Unexpected validation protocol message.",
            );
          awaitingAck = true;
          if (message.event.kind === "diagnostic")
            message.event.diagnostic = {
              ...message.event.diagnostic,
              ...provenance,
            };
          if (message.event.kind === "result")
            message.event.result.diagnostics =
              message.event.result.diagnostics.map(
                (diagnostic: SchemaDiagnostic) => ({
                  ...diagnostic,
                  ...provenance,
                }),
              );
          const event = freeze(message.event) as XercesValidationEvent;
          if (event.kind === "diagnostic")
            config.onDiagnostic?.(event.diagnostic);
          if (event.kind === "result") {
            resultSeen = true;
            if (!event.result.valid && config.errorPolicy === "throw") {
              invalidError = new SchemaError(
                "INVALID_XML",
                "XML does not conform to the compiled grammar.",
                event.result.diagnostics,
                undefined,
                event.result.diagnosticsTruncated,
              );
              worker.postMessage({ kind: "ack", id });
              awaitingAck = false;
              continue;
            }
          }
          yield event;
          worker.postMessage({ kind: "ack", id });
          awaitingAck = false;
        }
      } catch (cause) {
        if (!complete) stop(cause);
        throw cause;
      } finally {
        if (!complete && resultSeen && !disposed) {
          if (awaitingAck) worker.postMessage({ kind: "ack", id });
          try {
            const message = await next();
            complete = message.kind === "complete";
          } catch {}
        }
        if (!complete && !disposed)
          stop(
            new SchemaError(
              "ABORTED",
              "Validation output was abandoned; the grammar is invalidated.",
            ),
          );
        finish();
        activeHandler = undefined;
        activeControl = undefined;
        handlerProvenance = undefined;
        try {
          closeInput?.();
        } catch {}
        closeInput = undefined;
        busy = false;
      }
    },
  };
  return handle;
}

export const isolatedXercesCapabilities = Object.freeze({
  hardTimeout: true,
  incrementalValidation: true,
  typeInformation: true,
  resourceComposition: true,
  exactDiagnosticHandler: true,
  asyncDiagnosticHandler: true,
  diagnosticHandlerRequiresSharedArrayBuffer: true,
});

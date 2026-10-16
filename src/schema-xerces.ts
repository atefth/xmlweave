import {
  markNormalizedTransport,
  getNormalizedTransport,
} from "./validation-types.js";
import { createValidationBudget } from "./validation-budget.js";
import { SchemaError } from "./validation-types.js";
import type {
  SchemaSource,
  SchemaSourceKind,
  SchemaOptions,
  SchemaDiagnostic,
  SchemaValidationResult,
} from "./validation-types.js";
import { normalizeSchemaSource, sourceLimits } from "./schema-sources.js";
import { parseXml } from "./index.js";
import type { XercesModule } from "./vendor-xerces-runtime.js";
export interface XercesDerivationQuery {
  readonly namespaceURI: string;
  readonly name: string;
  readonly method?: number;
}
export interface XercesTypeIdentity {
  readonly schemaIdentity: string;
  readonly namespaceURI: string;
  readonly name: string;
}
export interface XercesFeatures {
  readonly fullSchemaChecking?: boolean;
  readonly identityConstraints?: boolean;
  readonly multipleImports?: boolean;
}
export interface XercesSchemaOptions extends SchemaOptions {
  wasmUrl?: string;
  typeQueries?: readonly XercesDerivationQuery[];
  features?: XercesFeatures;
  diagnosticHandler?: (
    diagnostic: Readonly<SchemaDiagnostic>,
  ) => void | PromiseLike<void>;
}
export interface XercesTypeInfo {
  readonly name: string | null;
  readonly namespaceURI: string | null;
  readonly rawName: string | null;
  readonly rawNamespaceURI: string | null;
  readonly identity: XercesTypeIdentity;
  readonly anonymous: boolean;
  readonly derivations: readonly boolean[];
  readonly primitiveType: {
    readonly name: string | null;
    readonly namespaceURI: string | null;
  } | null;
  readonly itemPrimitiveType: {
    readonly name: string | null;
    readonly namespaceURI: string | null;
  } | null;
  readonly variety: number;
}
export interface XercesStreamOptions extends XercesSchemaOptions {
  systemId?: string;
  sourceKind?: SchemaSourceKind;
  provenance?: "original" | "generated";
}
export interface XercesPSVI {
  readonly type: XercesTypeInfo | null;
  readonly memberType: XercesTypeInfo | null;
  readonly normalizedValue?: string | null;
  readonly schemaDefault?: string | null;
  readonly schemaSpecified?: boolean;
  readonly validity?: number;
}
export interface XercesAttribute {
  readonly name: string;
  readonly localName: string;
  readonly namespaceURI: string;
  readonly value: string;
  readonly specified: boolean;
  readonly isId: boolean;
  readonly psvi: XercesPSVI | null;
}
export interface XercesGeneratedLocator {
  readonly systemId: string | null;
  readonly line: number;
  readonly column: number;
}
export type XercesValidationEvent = (
  | { readonly kind: "startDocument" | "endDocument" }
  | {
      readonly kind: "startPrefixMapping";
      readonly prefix: string;
      readonly namespaceURI: string;
    }
  | { readonly kind: "endPrefixMapping"; readonly prefix: string }
  | {
      readonly kind: "startElement";
      readonly name: string;
      readonly localName: string;
      readonly namespaceURI: string;
      readonly psvi: XercesPSVI;
      readonly attributes: readonly XercesAttribute[];
    }
  | {
      readonly kind: "endElement";
      readonly name: string;
      readonly localName: string;
      readonly namespaceURI: string;
      readonly psvi: XercesPSVI;
    }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "processingInstruction";
      readonly target: string;
      readonly data: string;
    }
  | {
      readonly kind: "diagnostic";
      readonly diagnostic: Readonly<SchemaDiagnostic>;
    }
  | { readonly kind: "result"; readonly result: SchemaValidationResult }
) & {
  readonly generatedLocator?: XercesGeneratedLocator | null;
  readonly generatedReason?: "schema-default";
};
export interface XercesCompiledSchema {
  readonly disposed: boolean;
  validate(
    source: SchemaSource,
    options?: XercesSchemaOptions,
  ): Promise<SchemaValidationResult>;
  validateStream(
    chunks: AsyncIterable<string> | Iterable<string>,
    options?: XercesStreamOptions,
  ): AsyncIterable<XercesValidationEvent>;
  dispose(): void;
  queryTypeDerivation(
    type: XercesTypeIdentity,
    ancestor: { namespaceURI: string; name: string },
    method?: number,
  ): Promise<boolean>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function diagnosticMetadata(
  diagnostic: SchemaDiagnostic,
  source?: {
    sourceKind?: SchemaSourceKind;
    provenance?: "original" | "generated";
  },
): SchemaDiagnostic {
  const result = {
    ...diagnostic,
    ...(source?.sourceKind ? { sourceKind: source.sourceKind } : {}),
    ...(source?.provenance ? { provenance: source.provenance } : {}),
  };
  if (result.systemId == null) delete result.systemId;
  if (result.line !== undefined && result.line < 1) delete result.line;
  if (result.column !== undefined && result.column < 1) delete result.column;
  return result;
}
function optionsCheck(options: XercesSchemaOptions) {
  sourceLimits(options);
  for (const key of Object.keys(options))
    if (
      ![
        "signal",
        "maxBytes",
        "maxCharacters",
        "maxDiagnostics",
        "onDiagnostic",
        "diagnosticHandler",
        "errorPolicy",
        "wasmUrl",
        "typeQueries",
        "features",
        "systemId",
        "sourceKind",
        "provenance",
      ].includes(key)
    )
      throw new SchemaError(
        "UNSUPPORTED_CAPABILITY",
        `Unsupported Xerces setting: ${key}`,
      );
  if (options.typeQueries !== undefined && !Array.isArray(options.typeQueries))
    throw new SchemaError("INVALID_ARGUMENT", "typeQueries must be an array.");
  if (
    options.wasmUrl !== undefined &&
    (typeof options.wasmUrl !== "string" || !options.wasmUrl)
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "wasmUrl must be a nonempty string.",
    );
  if (
    options.features !== undefined &&
    (!options.features ||
      typeof options.features !== "object" ||
      Array.isArray(options.features))
  )
    throw new SchemaError("INVALID_ARGUMENT", "features must be an object.");
  if (
    options.maxDiagnostics !== undefined &&
    (!Number.isSafeInteger(options.maxDiagnostics) ||
      options.maxDiagnostics < 1 ||
      options.maxDiagnostics > 10000)
  )
    throw new SchemaError("INVALID_ARGUMENT", "Invalid diagnostic budget.");
  if (
    options.diagnosticHandler !== undefined &&
    typeof options.diagnosticHandler !== "function"
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "diagnosticHandler must be a function.",
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
    throw new SchemaError("INVALID_ARGUMENT", "Invalid error policy.");
}
function signal(options: XercesSchemaOptions) {
  if (options.signal?.aborted)
    throw new SchemaError("ABORTED", "Schema operation was aborted.");
}
function handleDiagnostic(
  options: XercesSchemaOptions,
  diagnostic: Readonly<SchemaDiagnostic>,
) {
  const result = options.diagnosticHandler?.(diagnostic);
  if (result && typeof result.then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new SchemaError(
      "UNSUPPORTED_CAPABILITY",
      "Raw Xerces diagnostic handlers must be synchronous; use the isolated provider for asynchronous handlers.",
    );
  }
  options.onDiagnostic?.(diagnostic);
}
function mergeOperationOptions(
  base: XercesSchemaOptions,
  overrides: XercesStreamOptions,
): XercesStreamOptions {
  optionsCheck(overrides);
  if (
    overrides.typeQueries !== undefined ||
    overrides.wasmUrl !== undefined ||
    overrides.features !== undefined
  )
    throw new SchemaError(
      "UNSUPPORTED_CAPABILITY",
      "WASM location, features and type queries are compile-time settings.",
    );
  const result = { ...base, ...overrides };
  for (const key of ["maxBytes", "maxCharacters", "maxDiagnostics"] as const) {
    if (
      base[key] !== undefined &&
      overrides[key] !== undefined &&
      overrides[key]! > base[key]!
    )
      throw new SchemaError(
        "INVALID_ARGUMENT",
        `${key} cannot exceed the inherited safety limit.`,
      );
    if (overrides[key] === undefined) result[key] = base[key];
  }
  return result;
}
/** Optional browser/Node Xerces-C++ WASM provider with genuine incremental PSVI output. */
export async function compileXercesSchema(
  input: SchemaSource | readonly SchemaSource[],
  options: XercesSchemaOptions = {},
): Promise<XercesCompiledSchema> {
  optionsCheck(options);
  options = {
    ...options,
    typeQueries: options.typeQueries?.map((q) => ({ ...q })),
  };
  signal(options);
  const queries = options.typeQueries ?? [];
  if (
    queries.length > 256 ||
    queries.some(
      (q) =>
        typeof q.name !== "string" ||
        typeof q.namespaceURI !== "string" ||
        !Number.isInteger(q.method ?? 0) ||
        (q.method ?? 0) < 0 ||
        (q.method ?? 0) > 15,
    )
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Invalid type derivation queries.",
    );
  const schemaIdentity =
    "urn:xmlweave:types:" +
    ((
      globalThis as unknown as { crypto?: { randomUUID?: () => string } }
    ).crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
  const features = {
    fullSchemaChecking: true,
    identityConstraints: true,
    multipleImports: true,
    ...options.features,
  };
  if (
    Object.entries(features).some(
      ([key, value]) =>
        ![
          "fullSchemaChecking",
          "identityConstraints",
          "multipleImports",
        ].includes(key) || typeof value !== "boolean",
    )
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Invalid Xerces feature settings.",
    );
  const suppliedSources = Array.isArray(input) ? input : [input];
  if (!suppliedSources.length || suppliedSources.length > 256)
    throw new SchemaError(
      "RESOURCE_LIMIT",
      "Supply between one and 256 schema sources.",
    );
  const sources = await Promise.all(
    suppliedSources.map((s) => normalizeSchemaSource(s, options)),
  );
  const ids = sources.map(
    (s, i) => s.systemId ?? `https://xmlweave.invalid/schema/${i}.xsd`,
  );
  if (new Set(ids).size !== ids.length)
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Schema system identifiers must be unique.",
    );
  for (const source of sources)
    try {
      parseXml(source.text);
    } catch (cause) {
      throw new SchemaError(
        "INVALID_SCHEMA",
        "Schema must be well-formed XML without DTDs.",
        [],
        cause,
      );
    }
  let module: XercesModule;
  try {
    module = await (
      await import("./vendor-xerces-runtime.js")
    ).loadXercesEngine(options);
  } catch (cause) {
    throw new SchemaError(
      "ENGINE_UNAVAILABLE",
      "Could not load the optional Xerces WASM provider.",
      [],
      cause,
    );
  }
  let disposed = false,
    busy = false;
  const diagnostics: SchemaDiagnostic[] = [];
  module.xmlweaveDiagnostic = (event) => {
    signal(options);
    if (event.kind === "diagnostic") {
      event.diagnostic = freeze(
        diagnosticMetadata(
          event.diagnostic,
          sources[ids.indexOf(event.diagnostic.systemId)],
        ),
      );
      if (diagnostics.length < (options.maxDiagnostics ?? 100))
        diagnostics.push(event.diagnostic);
      handleDiagnostic(options, event.diagnostic);
    } else if (event.kind === "failure")
      throw new SchemaError("INVALID_SCHEMA", event.message, diagnostics);
  };
  module.xmlweaveEmit = async () => {};
  try {
    module.ccall("xw_set_type_namespace", null, ["string"], [schemaIdentity]);
    for (const query of queries)
      module.ccall(
        "xw_add_type_query",
        null,
        ["string", "string", "number"],
        [query.namespaceURI, query.name, query.method ?? 0],
      );
    for (let i = 0; i < sources.length; i++)
      module.ccall(
        "xw_add_source",
        null,
        ["string", "string"],
        [ids[i], sources[i]!.text],
      );
    module.ccall(
      "xw_set_features",
      null,
      ["number", "number", "number"],
      [
        Number(features.fullSchemaChecking),
        Number(features.identityConstraints),
        Number(features.multipleImports),
      ],
    );
    const valid = await module.ccall("xw_compile", "number", [], [], {
      async: true,
    });
    if (module.xmlweaveFailed) throw module.xmlweaveFailure;
    if (!valid)
      throw new SchemaError(
        "INVALID_SCHEMA",
        "XSD compilation failed.",
        diagnostics,
      );
  } catch (cause) {
    module.ccall("xw_dispose", null, [], []);
    throw cause;
  }
  options = {
    ...options,
    signal: undefined,
    onDiagnostic: undefined,
    diagnosticHandler: undefined,
    errorPolicy: undefined,
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (!busy) module.ccall("xw_dispose", null, [], []);
  };
  const compiled: XercesCompiledSchema = {
    get disposed() {
      return disposed;
    },
    dispose,
    async queryTypeDerivation(type, ancestor, method = 0) {
      if (disposed)
        throw new SchemaError("DISPOSED", "Xerces schema has been disposed.");
      if (busy) throw new SchemaError("BUSY", "Xerces schema is active.");
      if (
        !type ||
        type.schemaIdentity !== schemaIdentity ||
        typeof type.name !== "string" ||
        typeof type.namespaceURI !== "string" ||
        !ancestor ||
        typeof ancestor.name !== "string" ||
        typeof ancestor.namespaceURI !== "string" ||
        !Number.isInteger(method) ||
        method < 0 ||
        method > 15
      )
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Type queries require a local snapshot identity, ancestor QName and DOM derivation mask.",
        );
      const result = module.ccall(
        "xw_query_type",
        "number",
        ["string", "string", "string", "string", "number"],
        [
          type.namespaceURI,
          type.name,
          ancestor.namespaceURI,
          ancestor.name,
          method,
        ],
      );
      if (result < 0)
        throw new SchemaError("INVALID_ARGUMENT", "Unknown type identity.");
      return Boolean(result);
    },
    async validate(source, operation = {}) {
      if (disposed)
        throw new SchemaError("DISPOSED", "Xerces schema has been disposed.");
      const normalized = await normalizeSchemaSource(
        source,
        mergeOperationOptions(options, operation),
      );
      const chunks = [normalized.text];
      markNormalizedTransport(chunks, normalized);
      let result: SchemaValidationResult | undefined;
      for await (const event of compiled.validateStream(chunks, {
        ...operation,
        systemId: normalized.systemId,
        sourceKind: normalized.sourceKind,
        provenance: normalized.provenance,
      }))
        if (event.kind === "result") result = event.result;
      return result!;
    },
    async *validateStream(chunks, operation = {}) {
      if (disposed)
        throw new SchemaError("DISPOSED", "Xerces schema has been disposed.");
      if (busy) throw new SchemaError("BUSY", "Xerces schema is active.");
      if (
        operation.typeQueries !== undefined ||
        operation.wasmUrl !== undefined ||
        operation.features !== undefined
      )
        throw new SchemaError(
          "UNSUPPORTED_CAPABILITY",
          "WASM location, features and type queries are compile-time settings.",
        );
      const config = mergeOperationOptions(options, operation);
      optionsCheck(config);
      const limits = sourceLimits(config);
      const transportBytes =
        getNormalizedTransport(chunks as object, limits.maxBytes) !== undefined
          ? sourceLimits().maxBytes
          : limits.maxBytes;
      signal(config);
      const iterator =
        Symbol.asyncIterator in Object(chunks)
          ? (chunks as AsyncIterable<string>)[Symbol.asyncIterator]()
          : (chunks as Iterable<string>)[Symbol.iterator]();
      const encoder = new (
        globalThis as unknown as {
          TextEncoder: new () => { encode(text: string): Uint8Array };
        }
      ).TextEncoder();
      let bytes: Uint8Array = new Uint8Array();
      let offset = 0,
        characters = 0,
        totalBytes = 0,
        tail = "",
        ended = false,
        closed = false;
      const queue: { event: any; acknowledge?: () => void }[] = [];
      let waiting:
        | ((
            record: { event: any; acknowledge?: () => void } | undefined,
          ) => void)
        | undefined;
      const pendingAcks = new Set<() => void>();
      let nativeDone = false,
        nativeValid = false,
        nativeError: unknown,
        nativeRejected = false,
        successful = false;
      const seen: SchemaDiagnostic[] = [];
      let truncated = false;
      const push = (record: { event: any; acknowledge?: () => void }) => {
        if (waiting) {
          const receive = waiting;
          waiting = undefined;
          receive(record);
        } else queue.push(record);
      };
      const countEvent = createValidationBudget();
      busy = true;
      module.xmlweaveFailure = undefined;
      module.xmlweaveFailed = false;
      module.xmlweaveRead = async (pointer, maximum) => {
        signal(config);
        if (closed || disposed)
          throw new SchemaError("ABORTED", "Validation stream was closed.");
        while (offset === bytes.length) {
          if (ended) return 0;
          const next = await iterator.next();
          if (next.done) {
            ended = true;
            if (tail)
              throw new SchemaError(
                "INVALID_XML",
                "Unmatched surrogate in streaming input.",
              );
            return 0;
          }
          if (typeof next.value !== "string")
            throw new SchemaError(
              "INVALID_ARGUMENT",
              "Xerces streaming input requires strings.",
            );
          characters += next.value.length;
          if (characters > limits.maxCharacters)
            throw new SchemaError(
              "RESOURCE_LIMIT",
              "Input character limit exceeded.",
            );
          let text = tail + next.value;
          tail = "";
          if (/[\uD800-\uDBFF]$/.test(text)) {
            tail = text.slice(-1);
            text = text.slice(0, -1);
          }
          for (const scalar of text) {
            const n = scalar.codePointAt(0)!;
            if (n >= 0xd800 && n <= 0xdfff)
              throw new SchemaError(
                "INVALID_XML",
                "Unmatched surrogate in streaming input.",
              );
          }
          bytes = encoder.encode(text);
          offset = 0;
          totalBytes += bytes.length;
          if (totalBytes > transportBytes)
            throw new SchemaError(
              "RESOURCE_LIMIT",
              "Input byte limit exceeded.",
            );
        }
        const length = Math.min(maximum, bytes.length - offset);
        module.HEAPU8.set(bytes.subarray(offset, offset + length), pointer);
        offset += length;
        return length;
      };
      module.xmlweaveDiagnostic = (event) => {
        signal(config);
        if (closed || disposed)
          throw new SchemaError("ABORTED", "Validation stream was closed.");
        if (event.kind === "diagnostic") {
          event.diagnostic = freeze(
            diagnosticMetadata(event.diagnostic, {
              sourceKind: operation.sourceKind ?? "chunks",
              provenance: operation.provenance ?? "original",
            }),
          );
          const retained = seen.length < (config.maxDiagnostics ?? 100);
          if (retained) seen.push(event.diagnostic);
          else truncated = true;
          handleDiagnostic(config, event.diagnostic);
          if (
            config.errorPolicy === "throw" &&
            event.diagnostic.severity !== "warning"
          )
            throw new SchemaError(
              "INVALID_XML",
              "XML validation failed.",
              seen,
            );
          if (!retained) return;
        }
        if (event.kind === "failure")
          throw new SchemaError("ENGINE_ERROR", event.message, seen);
        push({ event });
      };
      module.xmlweaveEmit = async (event) => {
        countEvent(event);
        signal(config);
        if (closed || disposed)
          throw new SchemaError("ABORTED", "Validation stream was closed.");
        await new Promise<void>((resolve) => {
          const acknowledge = () => {
            pendingAcks.delete(acknowledge);
            resolve();
          };
          pendingAcks.add(acknowledge);
          push({ event, acknowledge });
        });
      };
      const native = Promise.resolve()
        .then(() =>
          module.ccall(
            "xw_validate",
            "number",
            ["string"],
            [operation.systemId ?? "https://xmlweave.invalid/instance.xml"],
            { async: true },
          ),
        )
        .then(
          (value) => {
            nativeValid = Boolean(value);
          },
          (error) => {
            nativeRejected = true;
            nativeError = error;
          },
        )
        .finally(() => {
          nativeDone = true;
          waiting?.(undefined);
          waiting = undefined;
        });
      try {
        while (true) {
          let record = queue.shift();
          if (!record && !nativeDone)
            record = await new Promise((resolve) => {
              waiting = resolve;
            });
          if (record) {
            yield freeze(record.event);
            record.acknowledge?.();
          } else if (nativeDone) break;
        }
        await native;
        if (module.xmlweaveFailed) throw module.xmlweaveFailure;
        if (nativeRejected) throw nativeError;
        successful = true;
        yield freeze({
          kind: "result",
          result: {
            valid: nativeValid,
            diagnostics: seen,
            diagnosticsTruncated: truncated,
          },
        }) as XercesValidationEvent;
      } finally {
        closed = true;
        for (const acknowledge of pendingAcks) acknowledge();
        if (!successful) {
          disposed = true;
          void Promise.resolve(iterator.return?.()).catch(() => {});
        }
        await native;
        busy = false;
        if (disposed) module.ccall("xw_dispose", null, [], []);
      }
    },
  };
  return compiled;
}

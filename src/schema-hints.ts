import { parseXml } from "./index.js";
import {
  normalizeSourceWithDeadline,
  withinSourceDeadline,
} from "./source-deadline.js";
import { sourceLimits } from "./schema-sources.js";
import { SchemaError } from "./validation-types.js";
import type {
  SchemaSource,
  SchemaOptions,
  SchemaSignal,
  SchemaValidationResult,
  NormalizedSchemaSource,
} from "./validation-types.js";
import type {
  SchemaGraphOptions,
  SchemaResourceRequest,
} from "./schema-graph.js";
import type {
  IsolatedXercesOptions,
  IsolatedDiagnosticHandler,
} from "./schema-xerces-isolated.js";
export interface HintCompiledSchema {
  readonly disposed?: boolean;
  validate(
    source: SchemaSource,
    options?: HintOperationOptions,
  ): Promise<SchemaValidationResult>;
  dispose(): void;
}
export type HintSchemaCompiler = (
  sources: readonly SchemaSource[],
  options: IsolatedXercesOptions,
) => Promise<HintCompiledSchema>;
export interface HintValidatorOptions extends IsolatedXercesOptions {
  compiler?: HintSchemaCompiler;
  maxCachedSchemas?: number;
  maxPendingValidations?: number;
  maxHints?: number;
}
export interface HintOperationOptions extends SchemaOptions {
  timeoutMs?: number;
  diagnosticHandler?: IsolatedDiagnosticHandler;
}
export interface DynamicHintValidator {
  readonly disposed: boolean;
  readonly cacheSize: number;
  validate(
    source: SchemaSource,
    options?: HintOperationOptions,
  ): Promise<SchemaValidationResult>;
  clearCache(): void;
  dispose(): void;
}
export interface ApprovedInstanceHint {
  readonly namespace: string;
  readonly uri: string;
  readonly location: string;
  readonly baseURI: string;
}
const xsd = "http://www.w3.org/2001/XMLSchema",
  xsi = "http://www.w3.org/2001/XMLSchema-instance",
  xml = "http://www.w3.org/XML/1998/namespace";
function canonical(
  value: string,
  base = "https://xmlweave.invalid/instance.xml",
): string {
  try {
    const URLClass = (
      globalThis as unknown as {
        URL: new (value: string, base?: string) => { href: string };
      }
    ).URL;
    return new URLClass(value, base).href;
  } catch (cause) {
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Hint identifiers must resolve as URLs.",
      [],
      cause,
    );
  }
}
function limit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new SchemaError(
      "INVALID_ARGUMENT",
      `${name} must be between 1 and ${maximum}.`,
    );
  return value;
}
/** Collect document-wide hints without resolving resources or changing XML text. */
export function readDynamicSchemaHints(
  text: string,
  systemId?: string,
  maxHints = 128,
): readonly ApprovedInstanceHint[] {
  limit(maxHints, 128, 512, "maxHints");
  let document;
  try {
    document = parseXml(text);
  } catch (cause) {
    throw new SchemaError(
      "INVALID_XML",
      "Hint input must be well-formed XML without DTDs.",
      [],
      cause,
    );
  }
  const root = document.documentElement!,
    hints = new Map<string, ApprovedInstanceHint>();
  let requests = 0;
  const stack = [
    {
      element: root,
      base: canonical(systemId ?? "https://xmlweave.invalid/instance.xml"),
    },
  ];
  while (stack.length) {
    const { element, base: parentBase } = stack.pop()!;
    const localBase = element.getAttributeNS(xml, "base"),
      base = localBase === null ? parentBase : canonical(localBase, parentBase);
    if (element.namespaceURI === "http://www.w3.org/2001/XInclude")
      throw new SchemaError(
        "EXTERNAL_RESOURCE_FORBIDDEN",
        "XInclude is forbidden in hint-driven mode.",
      );
    const add = (namespace: string, location: string) => {
      if (++requests > maxHints)
        throw new SchemaError(
          "RESOURCE_LIMIT",
          "Instance hint count exceeds maxHints.",
        );
      const uri = canonical(location, base),
        previous = hints.get(namespace);
      if (previous && previous.uri !== uri)
        throw new SchemaError(
          "INVALID_XML",
          "Conflicting schema hints for one namespace are forbidden.",
        );
      if (!previous)
        hints.set(
          namespace,
          Object.freeze({ namespace, location, uri, baseURI: base }),
        );
    };
    const pairs = element.getAttributeNS(xsi, "schemaLocation");
    if (pairs !== null) {
      const words = pairs.trim().split(/\s+/).filter(Boolean);
      if (!words.length || words.length % 2)
        throw new SchemaError(
          "INVALID_XML",
          "schemaLocation requires namespace/location pairs.",
        );
      for (let i = 0; i < words.length; i += 2) add(words[i]!, words[i + 1]!);
    }
    const none = element.getAttributeNS(xsi, "noNamespaceSchemaLocation");
    if (none !== null) {
      const location = none.trim();
      if (!location || /\s/.test(location))
        throw new SchemaError(
          "INVALID_XML",
          "noNamespaceSchemaLocation requires one location.",
        );
      add("", location);
    }
    for (let i = element.childNodes.length - 1; i >= 0; i--) {
      const child = element.childNodes[i]!;
      if (child.nodeType === 1)
        stack.push({ element: child as typeof element, base });
    }
  }
  if (!hints.has(root.namespaceURI ?? ""))
    throw new SchemaError(
      "INVALID_XML",
      "A schema hint for the document element namespace is required.",
    );
  return Object.freeze(
    [...hints.values()].sort(
      (a, b) =>
        a.namespace.localeCompare(b.namespace) || a.uri.localeCompare(b.uri),
    ),
  );
}
function immutableSource(
  normalized: NormalizedSchemaSource,
  id: string,
): SchemaSource {
  return normalized.provenance === "generated"
    ? { kind: "dom", node: parseXml(normalized.text), systemId: id }
    : { kind: "text", text: normalized.text, systemId: id };
}
function exactHandler(handler: unknown) {
  if (handler === undefined) return;
  const runtime = globalThis as any;
  if (
    typeof runtime.SharedArrayBuffer !== "function" ||
    !runtime.Atomics ||
    (!runtime.process?.versions?.node && runtime.crossOriginIsolated !== true)
  )
    throw new SchemaError(
      "UNSUPPORTED_CAPABILITY",
      "Exact hint diagnostic handlers require SharedArrayBuffer and browser cross-origin isolation.",
    );
}
function operationOptions(options: HintOperationOptions) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Hint operation options must be an object.",
    );
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
        "timeoutMs",
      ].includes(key)
    )
      throw new SchemaError(
        "INVALID_ARGUMENT",
        `Unsupported hint operation option ${key}.`,
      );
  limit(options.timeoutMs, 30000, 3600000, "timeoutMs");
  limit(options.maxBytes, 4000000, 4000000, "maxBytes");
  limit(options.maxCharacters, 1000000, 1000000, "maxCharacters");
  limit(options.maxDiagnostics, 100, 10000, "maxDiagnostics");
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
    throw new SchemaError("INVALID_ARGUMENT", "Unsupported error policy.");
}
/** No-argument-schema equivalent: approved instance hints select a grammar separately for each document. */
export async function createHintValidator(
  input: HintValidatorOptions = {},
): Promise<DynamicHintValidator> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Hint factory options must be an object.",
    );
  sourceLimits(input);
  operationOptions({
    signal: input.signal,
    maxBytes: input.maxBytes,
    maxCharacters: input.maxCharacters,
    maxDiagnostics: input.maxDiagnostics,
    onDiagnostic: input.onDiagnostic,
    diagnosticHandler: input.diagnosticHandler,
    errorPolicy: input.errorPolicy,
    timeoutMs: input.timeoutMs,
  });
  const allowed = [
    "signal",
    "maxBytes",
    "maxCharacters",
    "maxDiagnostics",
    "onDiagnostic",
    "diagnosticHandler",
    "errorPolicy",
    "timeoutMs",
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
    "compiler",
    "maxCachedSchemas",
    "maxPendingValidations",
    "maxHints",
  ];
  for (const key of Object.keys(input))
    if (!allowed.includes(key))
      throw new SchemaError(
        "INVALID_ARGUMENT",
        `Unsupported hint factory option ${key}.`,
      );
  const cacheLimit = limit(input.maxCachedSchemas, 4, 16, "maxCachedSchemas"),
    pendingLimit = limit(
      input.maxPendingValidations,
      32,
      128,
      "maxPendingValidations",
    ),
    hintLimit = limit(input.maxHints, 128, 512, "maxHints"),
    resourceLimit = limit(input.maxDocuments, 128, 128, "maxDocuments"),
    byteLimit = limit(input.maxGraphBytes, 8000000, 8000000, "maxGraphBytes");
  if (input.compiler !== undefined && typeof input.compiler !== "function")
    throw new SchemaError("INVALID_ARGUMENT", "compiler must be a function.");
  if (input.resolver !== undefined && typeof input.resolver !== "function")
    throw new SchemaError("INVALID_ARGUMENT", "resolver must be a function.");
  for (const [key, value] of Object.entries({
    resourceMap: input.resourceMap,
    namespaceCatalog: input.namespaceCatalog,
  }))
    if (
      value !== undefined &&
      (!value || typeof value !== "object" || Array.isArray(value))
    )
      throw new SchemaError("INVALID_ARGUMENT", `${key} must be an object.`);
  limit(input.maxGraphDepth, 32, 32, "maxGraphDepth");
  limit(input.maxRequests, 512, 512, "maxRequests");
  if (
    input.typeQueries !== undefined &&
    (!Array.isArray(input.typeQueries) ||
      input.typeQueries.length > 256 ||
      input.typeQueries.some(
        (q) =>
          !q ||
          typeof q.name !== "string" ||
          typeof q.namespaceURI !== "string" ||
          !Number.isInteger(q.method ?? 0) ||
          (q.method ?? 0) < 0 ||
          (q.method ?? 0) > 15,
      ))
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Invalid type derivation queries.",
    );
  if (
    input.features !== undefined &&
    (!input.features ||
      typeof input.features !== "object" ||
      Array.isArray(input.features) ||
      Object.entries(input.features).some(
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
  for (const key of ["workerURL", "wasmUrl"] as const)
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || !input[key])
    )
      throw new SchemaError(
        "INVALID_ARGUMENT",
        `${key} must be a non-empty string.`,
      );
  if (input.compiler === undefined) exactHandler(input.diagnosticHandler);
  const options = {
    ...input,
    typeQueries: input.typeQueries?.map((query) => ({ ...query })),
    features: input.features ? { ...input.features } : undefined,
    namespaceCatalog: { ...input.namespaceCatalog },
  };
  const map = { ...input.resourceMap };
  const resources = new Map<string, SchemaSource>(),
    resolving = new Map<string, Promise<SchemaSource>>();
  let resourceBytes = 0,
    disposed = false;
  const tickets = new Set<symbol>();
  const Encoder = (
    globalThis as unknown as {
      TextEncoder: new () => { encode(text: string): Uint8Array };
    }
  ).TextEncoder;
  if (!Encoder)
    throw new SchemaError(
      "UNSUPPORTED_CAPABILITY",
      "Hint catalogue byte budgets require TextEncoder.",
    );
  const store = (id: string, normalized: NormalizedSchemaSource) => {
    if (resources.has(id)) return resources.get(id)!;
    if (resources.size >= resourceLimit)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "Pinned hint catalogue exceeds maxDocuments.",
      );
    const nextBytes =
      resourceBytes + new Encoder().encode(normalized.text).length;
    if (nextBytes > byteLimit)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "Pinned hint catalogue exceeds maxGraphBytes.",
      );
    resourceBytes = nextBytes;
    const source = immutableSource(normalized, id);
    resources.set(id, source);
    return source;
  };
  if (Object.keys(map).length > resourceLimit)
    throw new SchemaError(
      "RESOURCE_LIMIT",
      "Hint catalogue exceeds maxDocuments.",
    );
  for (const [key, source] of Object.entries(map)) {
    const id = canonical(key);
    if (resources.has(id))
      throw new SchemaError(
        "INVALID_ARGUMENT",
        "Hint resource identifiers must be canonically unique.",
      );
    store(id, await normalizeSourceWithDeadline(source, options));
  }
  const compiler: HintSchemaCompiler =
    options.compiler ??
    (async (sources, settings) => {
      const { compileIsolatedXercesSchema } = await import(
        "./schema-xerces-isolated.js"
      );
      return compileIsolatedXercesSchema(sources, settings);
    });
  interface Entry {
    key: string;
    promise: Promise<HintCompiledSchema>;
    handle?: HintCompiledSchema;
    references: number;
    tail: Promise<void>;
    invalid: boolean;
  }
  const cache = new Map<string, Entry>();
  const remove = (entry: Entry) => {
    if (cache.get(entry.key) === entry) cache.delete(entry.key);
    if (entry.invalid) return;
    entry.invalid = true;
    entry.handle?.dispose();
  };
  async function resolveResource(
    request: Readonly<SchemaResourceRequest>,
    signal: SchemaSignal,
    timeoutMs?: number,
  ): Promise<SchemaSource> {
    const id = canonical(request.requestedURI);
    const known = resources.get(id);
    if (known) return known;
    const existing = resolving.get(id);
    if (existing) return existing;
    const work = (async () => {
      if (!options.resolver)
        throw new SchemaError(
          "EXTERNAL_RESOURCE_FORBIDDEN",
          `No approved resource for ${id}.`,
        );
      const result = await withinSourceDeadline(
        () =>
          Promise.resolve(
            options.resolver!(Object.freeze({ ...request, requestedURI: id })),
          ),
        { signal, timeoutMs },
        () => disposed,
      );
      if (result === undefined)
        throw new SchemaError(
          "EXTERNAL_RESOURCE_FORBIDDEN",
          `No approved resource for ${id}.`,
        );
      return store(
        id,
        await normalizeSourceWithDeadline(
          result,
          { ...options, signal, timeoutMs },
          () => disposed,
        ),
      );
    })();
    resolving.set(id, work);
    try {
      return await work;
    } finally {
      resolving.delete(id);
    }
  }
  function touch(entry: Entry) {
    cache.delete(entry.key);
    cache.set(entry.key, entry);
  }
  const facade: DynamicHintValidator = {
    get disposed() {
      return disposed;
    },
    get cacheSize() {
      return cache.size;
    },
    clearCache() {
      if (tickets.size || [...cache.values()].some((entry) => entry.references))
        throw new SchemaError(
          "BUSY",
          "Cannot clear cached grammars while validation is active.",
        );
      for (const entry of [...cache.values()]) remove(entry);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...cache.values()]) remove(entry);
    },
    async validate(source, operation = {}) {
      if (disposed)
        throw new SchemaError(
          "DISPOSED",
          "The hint validator has been disposed.",
        );
      operationOptions(operation);
      if (options.compiler === undefined)
        exactHandler(operation.diagnosticHandler);
      operation = Object.fromEntries(
        Object.entries(operation).filter(([, value]) => value !== undefined),
      );
      for (const key of [
        "maxCharacters",
        "maxBytes",
        "maxDiagnostics",
        "timeoutMs",
      ] as const)
        if (
          options[key] !== undefined &&
          operation[key] !== undefined &&
          operation[key]! > options[key]!
        )
          throw new SchemaError(
            "INVALID_ARGUMENT",
            `${key} cannot exceed the factory ceiling.`,
          );
      if (tickets.size >= pendingLimit)
        throw new SchemaError(
          "RESOURCE_LIMIT",
          "Hint validator pending-operation limit exceeded.",
        );
      const ticket = Symbol();
      tickets.add(ticket);
      let owned: Entry | undefined;
      const settings = {
        timeoutMs: options.timeoutMs,
        maxCharacters: options.maxCharacters,
        maxBytes: options.maxBytes,
        maxDiagnostics: options.maxDiagnostics,
        ...operation,
      };
      return withinSourceDeadline(
        async (signal) => {
          try {
            const normalized = await normalizeSourceWithDeadline(
                source,
                { ...settings, signal },
                () => disposed,
              ),
              hints = readDynamicSchemaHints(
                normalized.text,
                normalized.systemId,
                hintLimit,
              );
            const selected: SchemaSource[] = [];
            for (const hint of hints) {
              const resolved = await resolveResource(
                Object.freeze({
                  kind: "hint",
                  namespace: hint.namespace,
                  systemId: hint.location,
                  requestedURI: hint.uri,
                  baseURI: hint.baseURI,
                }),
                signal,
                settings.timeoutMs,
              );
              const text = await normalizeSourceWithDeadline(
                resolved,
                { ...settings, signal },
                () => disposed,
              );
              const doc = parseXml(text.text),
                root = doc.documentElement!;
              if (
                root.namespaceURI !== xsd ||
                root.localName !== "schema" ||
                (root.getAttribute("targetNamespace") ?? "") !== hint.namespace
              )
                throw new SchemaError(
                  "INVALID_SCHEMA",
                  "Hint schema target namespace does not match the approved hint.",
                );
              selected.push(resolved);
            }
            const key = JSON.stringify(
              hints.map((hint) => [hint.namespace, hint.uri]),
            );
            let entry = cache.get(key);
            if (entry?.invalid || entry?.handle?.disposed) {
              remove(entry);
              entry = undefined;
            }
            if (!entry) {
              if (cache.size >= cacheLimit) {
                const idle = [...cache.values()].find(
                  (value) => !value.references,
                );
                if (!idle)
                  throw new SchemaError(
                    "RESOURCE_LIMIT",
                    "All bounded cached grammars are active.",
                  );
                remove(idle);
              }
              const {
                compiler: _compiler,
                maxCachedSchemas: _cached,
                maxPendingValidations: _pending,
                maxHints: _hints,
                signal: _signal,
                onDiagnostic: _observer,
                diagnosticHandler: _handler,
                errorPolicy: _policy,
                ...compileOptions
              } = options;
              const created: Entry = {
                key,
                promise: undefined as unknown as Promise<HintCompiledSchema>,
                references: 0,
                tail: Promise.resolve(),
                invalid: false,
              };
              created.promise = compiler(selected, {
                ...compileOptions,
                maxBytes: undefined,
                signal,
                onDiagnostic: options.onDiagnostic,
                diagnosticHandler: options.diagnosticHandler,
                resourceMap: Object.fromEntries(resources),
                resolver: (request) =>
                  resolveResource(request, signal, settings.timeoutMs),
                timeoutMs: settings.timeoutMs,
              }).then(
                (handle) => {
                  created.handle = handle;
                  if (disposed || created.invalid || signal.aborted) {
                    if (created.invalid) handle.dispose();
                    else remove(created);
                    throw new SchemaError(
                      disposed ? "DISPOSED" : "ABORTED",
                      "Hint compilation completed after cancellation.",
                    );
                  }
                  return handle;
                },
                (error) => {
                  remove(created);
                  throw error;
                },
              );
              entry = created;
              cache.set(key, entry);
            }
            touch(entry);
            entry.references++;
            let unlock!: () => void;
            const previous = entry.tail;
            entry.tail = new Promise<void>((resolve) => (unlock = resolve));
            try {
              await previous;
              if (signal.aborted)
                throw new SchemaError(
                  disposed ? "DISPOSED" : "ABORTED",
                  "Hint validation was cancelled.",
                );
              const handle = await entry.promise;
              owned = entry;
              const metadata = (
                diagnostic: import("./validation-types.js").SchemaDiagnostic,
              ) =>
                Object.freeze({
                  ...diagnostic,
                  systemId: diagnostic.systemId ?? normalized.systemId,
                  sourceKind: normalized.sourceKind,
                  provenance: normalized.provenance,
                });
              const result = await handle.validate(
                {
                  kind: "text",
                  text: normalized.text,
                  systemId: normalized.systemId,
                },
                {
                  ...settings,
                  maxBytes: undefined,
                  signal,
                  diagnosticHandler: operation.diagnosticHandler
                    ? (diagnostic) =>
                        operation.diagnosticHandler!(metadata(diagnostic))
                    : undefined,
                  onDiagnostic: operation.onDiagnostic
                    ? (diagnostic) =>
                        operation.onDiagnostic!(metadata(diagnostic))
                    : undefined,
                },
              );
              if (handle.disposed) remove(entry);
              return {
                ...result,
                diagnostics: result.diagnostics.map(metadata),
              };
            } catch (error) {
              if (entry.handle?.disposed || owned === entry) remove(entry);
              throw error;
            } finally {
              owned = undefined;
              entry.references--;
              unlock();
            }
          } finally {
            tickets.delete(ticket);
          }
        },
        settings,
        () => disposed,
        () => {
          if (owned) remove(owned);
        },
      );
    },
  };
  return facade;
}

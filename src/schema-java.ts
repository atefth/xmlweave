import {
  markNormalizedTransport,
  getNormalizedTransport,
} from "./validation-types.js";
import {
  normalizeSourceWithDeadline,
  remainingSourceTimeout,
} from "./source-deadline.js";
import { parseXml } from "./index.js";
import { normalizeSchemaSource, sourceLimits } from "./schema-sources.js";
import { createValidationBudget } from "./validation-budget.js";
import { SchemaError } from "./validation-types.js";
import type {
  SchemaSource,
  SchemaOptions,
  SchemaDiagnostic,
  SchemaValidationResult,
  SchemaSourceKind,
} from "./validation-types.js";
import type { Document } from "slimdom";
export interface JavaTypeIdentity {
  readonly schemaIdentity: string;
  readonly namespaceURI: string;
  readonly name: string;
}
export interface JavaDerivationQuery {
  readonly namespaceURI: string;
  readonly name: string;
  readonly method?: number;
}
export interface JavaSchemaOptions extends SchemaOptions {
  javaExecutable?: string;
  timeoutMs?: number;
  typeQueries?: readonly JavaDerivationQuery[];
  diagnosticHandler?: (
    diagnostic: Readonly<SchemaDiagnostic>,
  ) => void | PromiseLike<void>;
}
interface JavaStreamOptions extends JavaSchemaOptions {
  systemId?: string;
  sourceKind?: SchemaSourceKind;
  provenance?: "original" | "generated";
}
export interface JavaTypeInfo {
  readonly name: string | null;
  readonly namespaceURI: string | null;
  readonly derivations: readonly boolean[];
  readonly qNameValue: boolean;
  readonly identity: JavaTypeIdentity;
  readonly anonymous: boolean;
  readonly rawName: string | null;
  readonly rawNamespaceURI: string | null;
}
export interface JavaAttributeInfo {
  readonly name: string;
  readonly localName: string;
  readonly namespaceURI: string;
  readonly value: string;
  readonly type: JavaTypeInfo | null;
  readonly isId: boolean;
  readonly specified: boolean;
}
export type JavaValidationEvent = (
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
      readonly type: JavaTypeInfo | null;
      readonly attributes: readonly JavaAttributeInfo[];
    }
  | {
      readonly kind: "endElement";
      readonly specified: boolean;
      readonly name: string;
      readonly localName: string;
      readonly namespaceURI: string;
      readonly type: JavaTypeInfo | null;
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
  readonly generatedLocator?: {
    readonly systemId: string | null;
    readonly line: number;
    readonly column: number;
  };
  readonly generatedReason?: "schema-default";
};
export interface JavaCompiledSchema {
  readonly disposed: boolean;
  queryTypeDerivation(
    identity: JavaTypeIdentity,
    ancestor: { namespaceURI: string; name: string },
    method?: number,
  ): Promise<boolean>;
  validate(
    source: SchemaSource,
    options?: JavaSchemaOptions,
  ): Promise<SchemaValidationResult>;
  validateOutput(
    source: SchemaSource,
    options?: JavaSchemaOptions,
  ): Promise<{
    result: SchemaValidationResult;
    xml?: string;
    document?: Document;
  }>;
  validateStream(
    chunks: AsyncIterable<string> | Iterable<string>,
    options?: JavaStreamOptions,
  ): AsyncIterable<JavaValidationEvent>;
  dispose(): void;
  createValidator(options?: JavaSchemaOptions): JavaSchemaValidator;
}
export interface JavaSchemaValidator {
  readonly disposed: boolean;
  readonly busy: boolean;
  validate(
    source: SchemaSource,
    options?: JavaSchemaOptions,
  ): Promise<SchemaValidationResult>;
  validateStream(
    chunks: AsyncIterable<string> | Iterable<string>,
    options?: JavaStreamOptions,
  ): AsyncIterable<JavaValidationEvent>;
  reset(): void;
  dispose(): void;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const part of Object.values(value)) freeze(part);
    Object.freeze(value);
  }
  return value;
}
function effectiveOptions(
  base: JavaSchemaOptions,
  overrides: JavaStreamOptions = {},
  operation = true,
): JavaStreamOptions {
  checkOptions(overrides, operation);
  for (const key of [
    "maxCharacters",
    "maxBytes",
    "maxDiagnostics",
    "timeoutMs",
  ] as const)
    if (
      base[key] !== undefined &&
      overrides[key] !== undefined &&
      overrides[key]! > base[key]!
    )
      throw new SchemaError(
        "INVALID_ARGUMENT",
        `${key} cannot exceed the inherited safety limit.`,
      );
  const result = { ...base, ...overrides };
  for (const key of [
    "maxCharacters",
    "maxBytes",
    "maxDiagnostics",
    "timeoutMs",
  ] as const)
    if (overrides[key] === undefined) result[key] = base[key];
  return result;
}
function cleanDiagnostic(diagnostic: SchemaDiagnostic): SchemaDiagnostic {
  const copy = { ...diagnostic };
  if (copy.line !== undefined && copy.line < 1) delete copy.line;
  if (copy.column !== undefined && copy.column < 1) delete copy.column;
  if (copy.systemId == null) delete copy.systemId;
  return copy;
}
function checkOptions(options: JavaStreamOptions, operation = false) {
  sourceLimits(options);
  const allowed = [
    "signal",
    "maxBytes",
    "maxCharacters",
    "maxDiagnostics",
    "onDiagnostic",
    "diagnosticHandler",
    "errorPolicy",
    "javaExecutable",
    "timeoutMs",
    "typeQueries",
    ...(operation ? ["systemId", "sourceKind", "provenance"] : []),
  ];
  for (const key of Object.keys(options))
    if (!allowed.includes(key))
      throw new SchemaError(
        "INVALID_ARGUMENT",
        `Unsupported Java schema option: ${key}.`,
      );
  if (
    operation &&
    (options.typeQueries !== undefined || options.javaExecutable !== undefined)
  )
    throw new SchemaError(
      "UNSUPPORTED_CAPABILITY",
      "Executable and type queries are compile-time settings.",
    );
  if (
    options.javaExecutable !== undefined &&
    (typeof options.javaExecutable !== "string" || !options.javaExecutable)
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "javaExecutable must be a nonempty string.",
    );
  if (options.systemId !== undefined && typeof options.systemId !== "string")
    throw new SchemaError("INVALID_ARGUMENT", "systemId must be a string.");
  if (
    options.sourceKind !== undefined &&
    !["text", "bytes", "dom", "chunks"].includes(options.sourceKind)
  )
    throw new SchemaError("INVALID_ARGUMENT", "Unsupported sourceKind.");
  if (
    options.provenance !== undefined &&
    !["original", "generated"].includes(options.provenance)
  )
    throw new SchemaError("INVALID_ARGUMENT", "Unsupported provenance.");
  const limits = sourceLimits(options);
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 3600000)
  )
    throw new SchemaError("INVALID_ARGUMENT", "timeoutMs must be positive.");
  if (
    options.maxDiagnostics !== undefined &&
    (!Number.isSafeInteger(options.maxDiagnostics) ||
      options.maxDiagnostics < 1 ||
      options.maxDiagnostics > 10000)
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "maxDiagnostics must be between 1 and 10000.",
    );
  if (
    options.errorPolicy !== undefined &&
    !["result", "throw"].includes(options.errorPolicy)
  )
    throw new SchemaError("INVALID_ARGUMENT", "Unsupported error policy.");
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
  return limits;
}
/** Optional Node-only Java 17+ provider with an explicit schema catalogue. */
export async function compileJavaSchema(
  source: SchemaSource | readonly SchemaSource[],
  options: JavaSchemaOptions = {},
): Promise<JavaCompiledSchema> {
  checkOptions(options);
  if (options.typeQueries !== undefined && !Array.isArray(options.typeQueries))
    throw new SchemaError("INVALID_ARGUMENT", "typeQueries must be an array.");
  options = {
    ...options,
    typeQueries: options.typeQueries?.map((query) => ({ ...query })),
  };
  const compilationStarted = Date.now();
  if (options.signal?.aborted)
    throw new SchemaError("ABORTED", "Schema operation was aborted.");
  const suppliedSources = Array.isArray(source) ? source : [source];
  if (!suppliedSources.length || suppliedSources.length > 256)
    throw new SchemaError(
      "RESOURCE_LIMIT",
      "Supply between one and 256 schema sources.",
    );
  const sources = await Promise.all(
    suppliedSources.map((s) => normalizeSourceWithDeadline(s, options)),
  );
  for (const item of sources)
    try {
      parseXml(item.text);
    } catch (cause) {
      throw new SchemaError(
        "INVALID_SCHEMA",
        "Schema must be well-formed XML without DTDs.",
        [],
        cause,
      );
    }
  const queries = options.typeQueries ?? [];
  if (
    queries.length > 256 ||
    queries.some(
      (q) =>
        !q ||
        typeof q !== "object" ||
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
  const ids = sources.map((s, i) => s.systemId ?? `urn:xmlweave:schema:${i}`);
  if (new Set(ids).size !== ids.length)
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Schema identifiers must be unique.",
    );
  const schemaIdentity =
    "urn:xmlweave:types:" +
    (globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random()}-${Math.random()}`);
  const bridge = await import("./vendor-java-node.js");
  const transport = bridge.startJava(options);
  let disposed = false,
    busy = false;
  const children = new Set<JavaSchemaValidator>();
  const dispose = () => {
    disposed = true;
    for (const child of children) child.dispose();
    children.clear();
    transport.close();
  };
  const diagnostics: SchemaDiagnostic[] = [];
  let callbackFailed = false,
    callbackFailure: unknown;
  let compileTimer: ReturnType<typeof setTimeout> | undefined;
  let compilePoll: ReturnType<typeof setInterval> | undefined;
  let rejectCompilation!: (error: unknown) => void;
  const compilationStopped = new Promise<never>((_, reject) => {
    rejectCompilation = reject;
  });
  compilationStopped.catch(() => {});
  let timedOut = false,
    aborted = false;
  try {
    compileTimer = setTimeout(
      () => {
        timedOut = true;
        dispose();
        rejectCompilation(
          new SchemaError("TIMEOUT", "Java compilation deadline exceeded."),
        );
      },
      remainingSourceTimeout(options.timeoutMs, compilationStarted),
    );
  } catch (cause) {
    dispose();
    throw cause;
  }
  if (options.signal)
    compilePoll = setInterval(() => {
      if (options.signal?.aborted) {
        aborted = true;
        dispose();
        rejectCompilation(
          new SchemaError("ABORTED", "Java compilation was aborted."),
        );
      }
    }, 10);
  try {
    await transport.send(String(sources.length));
    await transport.send(schemaIdentity);
    await transport.send(String(queries.length));
    for (const query of queries) {
      await transport.send(query.namespaceURI);
      await transport.send(query.name);
      await transport.send(String(query.method ?? 0));
    }
    for (let i = 0; i < sources.length; i++) {
      await transport.send(ids[i]!);
      await transport.send(sources[i]!.text);
    }
    while (true) {
      const event = await transport.next();
      if (event.kind === "ready") break;
      if (event.kind === "diagnostic") {
        const diagnostic = freeze(cleanDiagnostic(event.diagnostic));
        if (diagnostics.length < (options.maxDiagnostics ?? 100))
          diagnostics.push(diagnostic);
        try {
          await Promise.race([
            Promise.resolve(options.diagnosticHandler?.(diagnostic)),
            compilationStopped,
          ]);
          options.onDiagnostic?.(diagnostic);
        } catch (cause) {
          callbackFailed = true;
          callbackFailure = cause;
          throw cause;
        }
        await transport.send("continue");
      } else if (event.kind === "failure")
        throw new SchemaError("INVALID_SCHEMA", event.message, diagnostics);
    }
  } catch (cause) {
    dispose();
    if (callbackFailed) throw callbackFailure;
    if (timedOut)
      throw new SchemaError(
        "TIMEOUT",
        "Java compilation deadline exceeded.",
        diagnostics,
        cause,
      );
    if (aborted)
      throw new SchemaError(
        "ABORTED",
        "Java compilation was aborted.",
        diagnostics,
        cause,
      );
    if (cause instanceof SchemaError) throw cause;
    throw new SchemaError(
      "ENGINE_UNAVAILABLE",
      "Java schema compilation could not complete.",
      diagnostics,
      cause,
    );
  } finally {
    if (compileTimer) clearTimeout(compileTimer);
    if (compilePoll) clearInterval(compilePoll);
  }
  options = {
    ...options,
    signal: undefined,
    onDiagnostic: undefined,
    diagnosticHandler: undefined,
    errorPolicy: undefined,
  };
  const compiled: JavaCompiledSchema = {
    get disposed() {
      return disposed;
    },
    dispose,
    async queryTypeDerivation(identity, ancestor, method = 0) {
      if (disposed)
        throw new SchemaError("DISPOSED", "Java schema has been disposed.");
      if (busy) throw new SchemaError("BUSY", "Java schema is active.");
      if (
        !identity ||
        identity.schemaIdentity !== schemaIdentity ||
        typeof identity.namespaceURI !== "string" ||
        typeof identity.name !== "string" ||
        !ancestor ||
        typeof ancestor.namespaceURI !== "string" ||
        typeof ancestor.name !== "string" ||
        !Number.isInteger(method) ||
        method < 0 ||
        method > 15
      )
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Invalid or foreign type identity.",
        );
      busy = true;
      const timer = setTimeout(dispose, options.timeoutMs ?? 30000);
      try {
        await transport.send("queryType");
        for (const part of [
          identity.namespaceURI,
          identity.name,
          ancestor.namespaceURI,
          ancestor.name,
          String(method),
        ])
          await transport.send(part);
        const event = await transport.next();
        if (event.kind !== "queryTypeResult")
          throw new SchemaError("ENGINE_ERROR", "Invalid type query response.");
        if (!event.found)
          throw new SchemaError("INVALID_ARGUMENT", "Unknown type identity.");
        return event.value;
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    },
    async validateOutput(input, operation = {}) {
      if (disposed)
        throw new SchemaError("DISPOSED", "Java schema has been disposed.");
      const started = Date.now(),
        settings = effectiveOptions(options, operation);
      const normalized = await normalizeSourceWithDeadline(
        input,
        settings,
        () => disposed,
      );
      const timeoutMs = remainingSourceTimeout(settings.timeoutMs, started);
      let xml = "",
        bindings: string[] = [];
      let result: SchemaValidationResult | undefined;
      const outputLimit = sourceLimits(
        effectiveOptions(options, operation),
      ).maxCharacters;
      const escape = (value: string, attribute = false) =>
        value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, attribute ? "&quot;" : '"')
          .replace(/\r/g, "&#13;")
          .replace(/\n/g, attribute ? "&#10;" : "\n")
          .replace(/\t/g, attribute ? "&#9;" : "\t");
      const chunks = [normalized.text];
      markNormalizedTransport(chunks, normalized);
      for await (const event of compiled.validateStream(chunks, {
        ...operation,
        timeoutMs,
        systemId: normalized.systemId,
        sourceKind: normalized.sourceKind,
        provenance: normalized.provenance,
      })) {
        if (event.kind === "startPrefixMapping")
          bindings.push(
            ` xmlns${event.prefix ? ":" + event.prefix : ""}="${escape(event.namespaceURI, true)}"`,
          );
        else if (event.kind === "startElement") {
          xml += `<${event.name}${bindings.join("")}${event.attributes
            .filter((a) => a.namespaceURI !== "http://www.w3.org/2000/xmlns/")
            .map((a) => ` ${a.name}="${escape(a.value, true)}"`)
            .join("")}>`;
          bindings = [];
        } else if (event.kind === "endElement") xml += `</${event.name}>`;
        else if (event.kind === "text") xml += escape(event.text);
        else if (event.kind === "processingInstruction")
          xml += `<?${event.target} ${event.data}?>`;
        else if (event.kind === "result") result = event.result;
        if (xml.length > outputLimit)
          throw new SchemaError(
            "RESOURCE_LIMIT",
            "Validated output character limit exceeded.",
          );
      }
      return result!.valid
        ? { result: result!, xml, document: parseXml(xml) }
        : { result: result! };
    },
    createValidator(defaults = {}) {
      if (disposed)
        throw new SchemaError("DISPOSED", "Java schema has been disposed.");
      checkOptions(defaults, true);
      defaults = effectiveOptions(
        { ...options, onDiagnostic: undefined },
        defaults,
      );
      defaults = {
        ...defaults,
        typeQueries: defaults.typeQueries?.map((query) => ({ ...query })),
      };
      const {
        javaExecutable: _executable,
        typeQueries: _queries,
        ...episodeDefaults
      } = defaults;
      let child: Promise<JavaCompiledSchema> | undefined;
      let closed = false,
        active = false;
      const get = () =>
        (child ??= compileJavaSchema(
          sources.map((s, i) => ({
            kind: "text",
            text: s.text,
            systemId: ids[i],
          })),
          {
            javaExecutable: options.javaExecutable,
            typeQueries: options.typeQueries,
            timeoutMs: options.timeoutMs,
            maxDiagnostics: options.maxDiagnostics,
          },
        ));
      const assert = () => {
        if (closed || disposed)
          throw new SchemaError(
            "DISPOSED",
            "Java validator has been disposed.",
          );
        if (active) throw new SchemaError("BUSY", "Java validator is active.");
      };
      const validator: JavaSchemaValidator = {
        get disposed() {
          return closed || disposed;
        },
        get busy() {
          return active;
        },
        async validate(input, overrides = {}) {
          assert();
          const settings = effectiveOptions(episodeDefaults, overrides);
          active = true;
          try {
            return await (await get()).validate(input, settings);
          } finally {
            active = false;
          }
        },
        async *validateStream(chunks, overrides = {}) {
          assert();
          const settings = effectiveOptions(episodeDefaults, overrides);
          active = true;
          try {
            yield* (await get()).validateStream(chunks, settings);
          } finally {
            active = false;
          }
        },
        reset() {
          assert();
        },
        dispose() {
          closed = true;
          children.delete(validator);
          void child?.then(
            (c) => c.dispose(),
            () => {},
          );
        },
      };
      children.add(validator);
      return validator;
    },
    async validate(input, operation = {}) {
      if (disposed)
        throw new SchemaError("DISPOSED", "Java schema has been disposed.");
      const started = Date.now(),
        settings = effectiveOptions(options, operation);
      const normalized = await normalizeSourceWithDeadline(
        input,
        settings,
        () => disposed,
      );
      const timeoutMs = remainingSourceTimeout(settings.timeoutMs, started);
      let result: SchemaValidationResult | undefined;
      const chunks = [normalized.text];
      markNormalizedTransport(chunks, normalized);
      for await (const event of compiled.validateStream(chunks, {
        ...operation,
        timeoutMs,
        systemId: normalized.systemId,
        sourceKind: normalized.sourceKind,
        provenance: normalized.provenance,
      })) {
        if (event.kind === "result") result = event.result;
      }
      return result!;
    },
    async *validateStream(chunks, operation = {}) {
      if (disposed)
        throw new SchemaError("DISPOSED", "Java schema has been disposed.");
      if (busy)
        throw new SchemaError(
          "BUSY",
          "A Java schema validation episode is already active.",
        );
      if (
        operation.typeQueries !== undefined ||
        operation.javaExecutable !== undefined
      )
        throw new SchemaError(
          "UNSUPPORTED_CAPABILITY",
          "Executable and type queries are compile-time settings.",
        );
      let complete = false;
      let failure: unknown;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      const configuration = effectiveOptions(options, operation);
      const seen: SchemaDiagnostic[] = [];
      const limit = configuration.maxDiagnostics ?? 100;
      let truncated = false;
      const limits = sourceLimits(configuration);
      const transportBytes =
        getNormalizedTransport(chunks as object, limits.maxBytes) !== undefined
          ? sourceLimits().maxBytes
          : limits.maxBytes;
      const countEvent = createValidationBudget();
      const asyncFactory =
        chunks == null
          ? undefined
          : (chunks as AsyncIterable<string>)[Symbol.asyncIterator];
      const syncFactory =
        chunks == null
          ? undefined
          : (chunks as Iterable<string>)[Symbol.iterator];
      if (
        typeof asyncFactory !== "function" &&
        typeof syncFactory !== "function"
      )
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Java streaming input requires an iterable.",
        );
      let input: AsyncIterator<string> | Iterator<string>;
      try {
        input =
          typeof asyncFactory === "function"
            ? asyncFactory.call(chunks)
            : syncFactory!.call(chunks);
        if (!input || typeof input.next !== "function")
          throw new Error("Invalid iterator.");
      } catch (cause) {
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Could not acquire the streaming iterator.",
          [],
          cause,
        );
      }
      busy = true;
      let rejectStop!: (error: unknown) => void;
      const stopped = new Promise<never>((_, reject) => {
        rejectStop = reject;
      });
      stopped.catch(() => {});
      const terminate = (error: SchemaError) => {
        failure = error;
        rejectStop(error);
        dispose();
      };
      timer = setTimeout(
        () =>
          terminate(
            new SchemaError("TIMEOUT", "Java validation deadline exceeded."),
          ),
        configuration.timeoutMs ?? 30000,
      );
      if (configuration.signal)
        poll = setInterval(() => {
          if (configuration.signal?.aborted)
            terminate(
              new SchemaError("ABORTED", "Java validation was aborted."),
            );
        }, 10);
      let count = 0,
        bytes = 0,
        tail = "";
      const sendNextChunk = async () => {
        while (!disposed) {
          const next = await Promise.race([
            Promise.resolve(input.next()),
            stopped,
          ]);
          if (next.done) {
            if (tail)
              throw new SchemaError(
                "INVALID_XML",
                "Input ends with an unmatched surrogate.",
              );
            await transport.send("");
            return;
          }
          const chunk = next.value;
          if (typeof chunk !== "string")
            throw new SchemaError(
              "INVALID_ARGUMENT",
              "Java streaming input requires strings.",
            );
          count += chunk.length;
          if (count > limits.maxCharacters)
            throw new SchemaError(
              "RESOURCE_LIMIT",
              "Java input character limit exceeded.",
            );
          let text = tail + chunk;
          tail = "";
          if (/[\uD800-\uDBFF]$/.test(text)) {
            tail = text.slice(-1);
            text = text.slice(0, -1);
          }
          for (const scalar of text) {
            const code = scalar.codePointAt(0)!;
            if (code >= 0xd800 && code <= 0xdfff)
              throw new SchemaError(
                "INVALID_XML",
                "Input contains an unmatched surrogate.",
              );
            bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
          }
          if (bytes > transportBytes)
            throw new SchemaError(
              "RESOURCE_LIMIT",
              "Java input byte limit exceeded.",
            );
          if (text.length) {
            await transport.send(text);
            return;
          }
        }
      };
      try {
        if (configuration.signal?.aborted)
          throw new SchemaError("ABORTED", "Java validation was aborted.");
        await transport.send("validate");
        await transport.send(operation.systemId ?? "urn:xmlweave:instance");
        while (true) {
          const event = await transport.next();
          countEvent(event);
          if (failure) throw failure;
          if (event.kind === "needChunk") {
            await sendNextChunk();
            continue;
          }
          if (event.kind === "result") {
            complete = true;
            const result = freeze({
              valid: event.valid,
              diagnostics: seen,
              diagnosticsTruncated: truncated,
            });
            if (!result.valid && configuration.errorPolicy === "throw")
              throw new SchemaError(
                "INVALID_XML",
                "XML is not valid against the schema.",
                seen,
              );
            yield { kind: "result", result };
            break;
          }
          if (event.kind === "diagnostic") {
            event.diagnostic = freeze(
              cleanDiagnostic({
                ...event.diagnostic,
                sourceKind: configuration.sourceKind ?? "chunks",
                provenance: configuration.provenance ?? "original",
              }),
            );
            const retained = seen.length < limit;
            if (retained) seen.push(event.diagnostic);
            else truncated = true;
            await Promise.race([
              Promise.resolve(
                configuration.diagnosticHandler?.(event.diagnostic),
              ),
              stopped,
            ]);
            configuration.onDiagnostic?.(event.diagnostic);
            if (
              configuration.errorPolicy === "throw" &&
              event.diagnostic.severity !== "warning"
            )
              throw new SchemaError(
                "INVALID_XML",
                "XML is not valid against the schema.",
                seen,
              );
            if (retained) yield freeze(event);
            await transport.send("continue");
          } else if (event.kind === "failure")
            throw new SchemaError(
              event.code === "UNSUPPORTED_CAPABILITY"
                ? "UNSUPPORTED_CAPABILITY"
                : "ENGINE_ERROR",
              event.message,
              seen,
            );
          else yield freeze(event);
        }
      } catch (cause) {
        if (failure) throw failure;
        throw cause;
      } finally {
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        if (!complete) {
          dispose();
          try {
            void Promise.resolve(input.return?.()).catch(() => {});
          } catch {}
        }
        busy = false;
      }
    },
  };
  return compiled;
}

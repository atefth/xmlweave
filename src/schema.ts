import { parseXml } from "./index.js";
import {
  checkSchemaSignal,
  normalizeSchemaSource,
  sourceLimits,
} from "./schema-sources.js";
import {
  SchemaError,
  type SchemaDiagnostic,
  type SchemaOptions,
  type SchemaSource,
  type NormalizedSchemaSource,
  type SchemaPhase,
  type CompiledSchema,
  type SchemaValidator,
} from "./validation-types.js";
export { SchemaError } from "./validation-types.js";
export type {
  SchemaSignal,
  SchemaSourceKind,
  SchemaSource,
  SchemaSourceOptions,
  NormalizedSchemaSource,
  SchemaPhase,
  SchemaDiagnostic,
  SchemaErrorCode,
  SchemaOptions,
  SchemaValidationResult,
  SchemaValidator,
  CompiledSchema,
} from "./validation-types.js";
export { normalizeSchemaSource } from "./schema-sources.js";

export const schemaCapabilities = Object.freeze({
  provider: "xerces-c-wasm",
  version: "4.0.0",
  xsdVersion: "1.0",
  sources: Object.freeze(["text", "bytes", "dom", "chunks"]),
  byteEncodings: Object.freeze([
    "utf-8",
    "utf-16le",
    "utf-16be",
    "utf-32le",
    "utf-32be",
    "iso-8859-1",
    "us-ascii",
  ]),
  additionalByteEncodings: "runtime-TextDecoder",
  bufferedChunks: true,
  independentSessions: true,
  originalSourceLocations: true,
  postOperationObserver: true,
  immediateErrorHandler: false,
  successfulWarnings: false,
  incrementalValidation: false,
  typeInformation: false,
  augmentedOutput: false,
  hardCancellation: false,
});
export interface SchemaEngineOptions extends SchemaOptions {
  wasmUrl?: string;
}
function optionsSnapshot(
  options?: SchemaEngineOptions,
  engineOptions = false,
): SchemaEngineOptions {
  sourceLimits(options);
  if (options)
    for (const key of Object.keys(options))
      if (
        ![
          "signal",
          "maxBytes",
          "maxCharacters",
          "maxDiagnostics",
          "onDiagnostic",
          "errorPolicy",
          ...(engineOptions ? ["wasmUrl"] : []),
        ].includes(key)
      )
        throw new SchemaError(
          "INVALID_ARGUMENT",
          `Unsupported schema option: ${key}.`,
        );
  if (
    options?.maxDiagnostics !== undefined &&
    (!Number.isSafeInteger(options.maxDiagnostics) ||
      options.maxDiagnostics < 1 ||
      options.maxDiagnostics > 10_000)
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "maxDiagnostics must be an integer from 1 to 10000.",
    );
  if (
    options?.onDiagnostic !== undefined &&
    typeof options.onDiagnostic !== "function"
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "onDiagnostic must be a function.",
    );
  if (
    options?.errorPolicy !== undefined &&
    !["result", "throw"].includes(options.errorPolicy)
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "errorPolicy must be result or throw.",
    );
  if (
    engineOptions &&
    options?.wasmUrl !== undefined &&
    typeof options.wasmUrl !== "string"
  )
    throw new SchemaError("INVALID_ARGUMENT", "wasmUrl must be a string.");
  return { ...options };
}
function diagnostics(
  cause: unknown,
  source?: NormalizedSchemaSource,
  phase: SchemaPhase = "validate",
): SchemaDiagnostic[] {
  const record = cause as {
    details?: unknown[];
    message?: string;
    line?: number;
    column?: number;
  } | null;
  const metadata = {
    phase,
    ...(source
      ? {
          systemId: source.systemId,
          sourceKind: source.sourceKind,
          provenance: source.provenance,
        }
      : {}),
  };
  if (record && Array.isArray(record.details))
    return record.details.map((raw) => {
      const detail = raw as {
        message: unknown;
        level: number;
        line: number;
        col: number;
        xpath?: string;
        file?: string;
      };
      return {
        ...metadata,
        message: String(detail.message).trim(),
        severity:
          detail.level === 1
            ? "warning"
            : detail.level === 3
              ? "fatal"
              : "error",
        ...(detail.line > 0 ? { line: detail.line } : {}),
        ...(detail.col > 0 ? { column: detail.col } : {}),
        ...(typeof detail.xpath === "string" ? { path: detail.xpath } : {}),
        ...(detail.file ? { systemId: detail.file } : {}),
      };
    });
  return [
    {
      ...metadata,
      message: cause instanceof Error ? cause.message : String(cause),
      severity: "error",
      ...(record?.line ? { line: record.line } : {}),
      ...(record?.column ? { column: record.column } : {}),
    },
  ];
}
function safeXml(
  source: NormalizedSchemaSource,
  schema: boolean,
  options: SchemaOptions,
): void {
  let doc;
  try {
    doc = parseXml(source.text, { maxLength: options.maxCharacters });
  } catch (cause) {
    throw new SchemaError(
      schema ? "INVALID_SCHEMA" : "INVALID_XML",
      "Expected well-formed XML without DTDs and within core resource limits.",
      diagnostics(cause, source, "parse"),
      cause,
    );
  }
  const root = doc.documentElement!;
  const xsd = "http://www.w3.org/2001/XMLSchema";
  if (schema && (root.namespaceURI !== xsd || root.localName !== "schema"))
    throw new SchemaError(
      "INVALID_SCHEMA",
      "Expected an XSD 1.0 schema root.",
      diagnostics(new Error("Expected XSD schema root."), source, "compile"),
    );
  const stack = [root];
  while (stack.length) {
    const element = stack.pop()!;
    if (
      (element.namespaceURI === xsd &&
        ["include", "import", "redefine", "override"].includes(
          element.localName,
        )) ||
      element.namespaceURI === "http://www.w3.org/2001/XInclude"
    )
      throw new SchemaError(
        "EXTERNAL_RESOURCE_FORBIDDEN",
        "Schema composition and XInclude require the isolated composition provider.",
      );
    if (
      element.hasAttributeNS(
        "http://www.w3.org/2001/XMLSchema-instance",
        "schemaLocation",
      ) ||
      element.hasAttributeNS(
        "http://www.w3.org/2001/XMLSchema-instance",
        "noNamespaceSchemaLocation",
      )
    )
      throw new SchemaError(
        "EXTERNAL_RESOURCE_FORBIDDEN",
        "Instance schema-location hints require an explicit hint policy.",
      );
    if (
      schema &&
      element.namespaceURI === xsd &&
      ["assert", "alternative", "openContent", "defaultOpenContent"].includes(
        element.localName,
      )
    )
      throw new SchemaError(
        "INVALID_SCHEMA",
        "XSD 1.1 constructs are not supported.",
      );
    for (const child of element.childNodes)
      if (child.nodeType === 1) stack.push(child as typeof element);
  }
}
/** Warm the default native engine; the temporary native instance is immediately released. */
export async function loadSchemaEngine(
  options?: SchemaEngineOptions,
): Promise<void> {
  const settings = optionsSnapshot(options, true);
  checkSchemaSignal(settings);
  try {
    const { loadXercesEngine } = await import("./vendor-xerces-runtime.js");
    const module = await loadXercesEngine(settings);
    try {
      checkSchemaSignal(settings);
    } finally {
      module.ccall("xw_dispose", null, [], []);
    }
  } catch (cause) {
    if (cause instanceof SchemaError) throw cause;
    throw new SchemaError(
      "ENGINE_UNAVAILABLE",
      "Could not load the default Xerces WASM engine.",
      diagnostics(cause),
      cause,
    );
  }
}
function observe(error: SchemaError, options: SchemaOptions): SchemaError {
  const max = options.maxDiagnostics ?? 100;
  const selected = error.diagnostics
    .slice(0, max)
    .map((d) => Object.freeze({ ...d }));
  for (const item of selected) options.onDiagnostic?.(item);
  return new SchemaError(
    error.code,
    error.message,
    selected,
    error.cause,
    error.diagnostics.length > max,
  );
}
export async function compileSchema(
  input: SchemaSource,
  options?: SchemaEngineOptions,
): Promise<CompiledSchema> {
  const configuration = optionsSnapshot(options, true);
  checkSchemaSignal(configuration);
  let source: NormalizedSchemaSource;
  try {
    source = await normalizeSchemaSource(input, configuration);
    safeXml(source, true, configuration);
  } catch (cause) {
    if (cause instanceof SchemaError) throw observe(cause, configuration);
    throw cause;
  }
  const { compileXercesSchema } = await import("./schema-xerces.js");
  let grammar: Awaited<ReturnType<typeof compileXercesSchema>>;
  const compileDiagnostics: SchemaDiagnostic[] = [];
  try {
    grammar = await compileXercesSchema(
      { kind: "text", text: source.text, systemId: source.systemId },
      {
        ...configuration,
        maxBytes: undefined,
        errorPolicy: "result",
        onDiagnostic: (diagnostic) =>
          compileDiagnostics.push({
            ...diagnostic,
            phase: "compile",
            systemId: diagnostic.systemId ?? source.systemId,
            sourceKind: source.sourceKind,
            provenance: source.provenance,
          }),
      },
    );
  } catch (cause) {
    if (cause instanceof SchemaError)
      throw observe(
        new SchemaError(
          cause.code,
          cause.message,
          cause.diagnostics.map((d) => ({
            ...d,
            phase: "compile",
            systemId: d.systemId ?? source.systemId,
            sourceKind: source.sourceKind,
            provenance: source.provenance,
          })),
          cause.cause,
          cause.diagnosticsTruncated,
        ),
        configuration,
      );
    throw observe(
      new SchemaError(
        "INVALID_SCHEMA",
        "XSD schema compilation failed.",
        diagnostics(cause, source, "compile"),
        cause,
      ),
      configuration,
    );
  }
  try {
    for (const diagnostic of compileDiagnostics)
      configuration.onDiagnostic?.(Object.freeze(diagnostic));
  } catch (error) {
    grammar.dispose();
    throw error;
  }
  let pending = Promise.resolve();
  async function serialize<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = pending;
    pending = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  let disposed = false;
  const children = new Set<SchemaValidator>();
  let active = 0;
  function createValidator(options?: SchemaOptions): SchemaValidator {
    if (disposed)
      throw new SchemaError(
        "DISPOSED",
        "The compiled schema has been disposed.",
      );
    // Factory observers are not inherited by validation sessions.
    const processingLimits = {
      maxCharacters: configuration.maxCharacters,
      maxBytes: configuration.maxBytes,
      maxDiagnostics: configuration.maxDiagnostics,
    };
    const withinFactory = (settings: SchemaOptions): SchemaOptions => {
      for (const key of [
        "maxCharacters",
        "maxBytes",
        "maxDiagnostics",
      ] as const)
        if (
          configuration[key] !== undefined &&
          settings[key] !== undefined &&
          settings[key]! > configuration[key]!
        )
          throw new SchemaError(
            "INVALID_ARGUMENT",
            `${key} cannot exceed the compiled grammar's processing limit.`,
          );
      return settings;
    };
    const initial = withinFactory(
      optionsSnapshot({ ...processingLimits, ...optionsSnapshot(options) }),
    );
    let busy = false;
    let dead = false;
    const session: SchemaValidator = {
      get disposed() {
        return dead || disposed;
      },
      get busy() {
        return busy;
      },
      async validate(input, overrides) {
        if (dead || disposed)
          throw new SchemaError("DISPOSED", "The validator has been disposed.");
        if (busy)
          throw new SchemaError("BUSY", "The validator is already validating.");
        if (active >= 32)
          throw new SchemaError(
            "RESOURCE_LIMIT",
            "A compiled grammar supports at most 32 active or queued validation episodes.",
          );
        const settings = withinFactory(
          optionsSnapshot({ ...initial, ...optionsSnapshot(overrides) }),
        );
        checkSchemaSignal(settings);
        busy = true;
        active++;
        try {
          let prepared: NormalizedSchemaSource;
          try {
            prepared = await normalizeSchemaSource(input, settings);
            safeXml(prepared, false, settings);
          } catch (cause) {
            if (cause instanceof SchemaError) throw observe(cause, settings);
            throw cause;
          }
          const nativeResult = await serialize(async () => {
            checkSchemaSignal(settings);
            return grammar.validate(
              {
                kind: "text",
                text: prepared.text,
                systemId: prepared.systemId,
              },
              {
                ...settings,
                maxBytes: undefined,
                signal: settings.signal,
                errorPolicy: "result",
                onDiagnostic: undefined,
              },
            );
          });
          const list = nativeResult.diagnostics.map((d) => ({
            ...d,
            phase: "validate" as const,
            systemId: d.systemId ?? prepared.systemId,
            sourceKind: prepared.sourceKind,
            provenance: prepared.provenance,
          }));
          checkSchemaSignal(settings);
          const max = settings.maxDiagnostics ?? 100;
          const selected = list
            .slice(0, max)
            .map((d) => Object.freeze({ ...d }));
          for (const item of selected) settings.onDiagnostic?.(item);
          if (!nativeResult.valid && settings.errorPolicy === "throw")
            throw new SchemaError(
              "INVALID_XML",
              "XML does not satisfy the compiled schema.",
              selected,
              undefined,
              nativeResult.diagnosticsTruncated || list.length > max,
            );
          return {
            valid: nativeResult.valid,
            diagnostics: selected,
            ...(nativeResult.diagnosticsTruncated || list.length > max
              ? { diagnosticsTruncated: true }
              : {}),
          };
        } finally {
          busy = false;
          active--;
        }
      },
      reset() {
        if (dead || disposed)
          throw new SchemaError("DISPOSED", "The validator has been disposed.");
        if (busy)
          throw new SchemaError("BUSY", "Cannot reset a busy validator.");
      },
      dispose() {
        if (busy)
          throw new SchemaError("BUSY", "Cannot dispose a busy validator.");
        dead = true;
        children.delete(session);
      },
    };
    children.add(session);
    return session;
  }
  return {
    get disposed() {
      return disposed;
    },
    createValidator,
    async validate(input, options) {
      const session = createValidator();
      try {
        return await session.validate(input, options);
      } finally {
        session.dispose();
      }
    },
    dispose() {
      if (disposed) return;
      if (active)
        throw new SchemaError(
          "BUSY",
          "Cannot dispose a grammar with active validation sessions.",
        );
      for (const session of children) session.dispose();
      grammar.dispose();
      disposed = true;
    },
  };
}

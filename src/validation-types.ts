import type { Document, Element } from "slimdom";

export interface SchemaSignal {
  readonly aborted: boolean;
}
export type SchemaSourceKind = "text" | "bytes" | "dom" | "chunks";
export type SchemaSource =
  | string
  | { kind: "text"; text: string; systemId?: string }
  | { kind: "bytes"; bytes: Uint8Array; systemId?: string; encoding?: string }
  | { kind: "dom"; node: Document | Element; systemId?: string }
  | {
      kind: "chunks";
      chunks:
        | AsyncIterable<string | Uint8Array>
        | Iterable<string | Uint8Array>;
      systemId?: string;
      encoding?: string;
    };
export interface SchemaSourceOptions {
  signal?: SchemaSignal;
  maxBytes?: number;
  maxCharacters?: number;
}
export interface NormalizedSchemaSource {
  text: string;
  systemId?: string;
  sourceKind: SchemaSourceKind;
  provenance: "original" | "generated";
}
export type SchemaPhase = "source" | "parse" | "compile" | "validate";
export interface SchemaDiagnostic {
  message: string;
  severity: "warning" | "error" | "fatal";
  line?: number;
  column?: number;
  path?: string;
  phase?: SchemaPhase;
  systemId?: string;
  sourceKind?: SchemaSourceKind;
  provenance?: "original" | "generated";
}
export type SchemaErrorCode =
  | "ABORTED"
  | "ENGINE_UNAVAILABLE"
  | "INVALID_SCHEMA"
  | "INVALID_XML"
  | "EXTERNAL_RESOURCE_FORBIDDEN"
  | "DISPOSED"
  | "BUSY"
  | "INVALID_ARGUMENT"
  | "RESOURCE_LIMIT"
  | "UNSUPPORTED_ENCODING"
  | "UNSUPPORTED_CAPABILITY"
  | "TIMEOUT"
  | "ENGINE_ERROR";
export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  readonly diagnostics: readonly SchemaDiagnostic[];
  readonly diagnosticsTruncated?: boolean;
  constructor(
    code: SchemaErrorCode,
    message: string,
    diagnostics: readonly SchemaDiagnostic[] = [],
    cause?: unknown,
    diagnosticsTruncated?: boolean,
  ) {
    super(message, { cause });
    this.name = "SchemaError";
    this.code = code;
    this.diagnostics = diagnostics;
    if (diagnosticsTruncated) this.diagnosticsTruncated = true;
  }
}
export interface SchemaOptions extends SchemaSourceOptions {
  maxDiagnostics?: number;
  onDiagnostic?: (diagnostic: Readonly<SchemaDiagnostic>) => void;
  errorPolicy?: "result" | "throw";
}
export interface SchemaValidationResult {
  valid: boolean;
  diagnostics: readonly SchemaDiagnostic[];
  diagnosticsTruncated?: boolean;
}
export interface SchemaValidator {
  readonly disposed: boolean;
  readonly busy: boolean;
  validate(
    source: SchemaSource,
    options?: SchemaOptions,
  ): Promise<SchemaValidationResult>;
  reset(): void;
  dispose(): void;
}
export interface CompiledSchema {
  readonly disposed: boolean;
  createValidator(options?: SchemaOptions): SchemaValidator;
  validate(
    source: SchemaSource,
    options?: SchemaOptions,
  ): Promise<SchemaValidationResult>;
  dispose(): void;
}

// Internal cross-adapter identity. Public option values cannot forge this brand.
type NormalizedTransportMetadata = Pick<
  NormalizedSchemaSource,
  "sourceKind" | "provenance" | "systemId"
> & { readonly originalBytes?: number };
const normalizedTransports = new WeakMap<
  object,
  Readonly<NormalizedTransportMetadata>
>();
const normalizedSourceBytes = new WeakMap<object, number>();
export function recordNormalizedSourceBytes<T extends object>(
  source: T,
  bytes: number | undefined,
): T {
  if (bytes !== undefined) normalizedSourceBytes.set(source, bytes);
  return source;
}
export function markNormalizedTransport<T extends object>(
  transport: T,
  metadata: NormalizedTransportMetadata,
): T {
  const originalBytes =
    metadata.originalBytes ?? normalizedSourceBytes.get(metadata);
  normalizedTransports.set(
    transport,
    Object.freeze({
      sourceKind: metadata.sourceKind,
      provenance: metadata.provenance,
      ...(metadata.systemId === undefined
        ? {}
        : { systemId: metadata.systemId }),
      ...(originalBytes === undefined ? {} : { originalBytes }),
    }),
  );
  return transport;
}
export function getNormalizedTransport(
  transport: object,
  maxBytes?: number,
): Readonly<NormalizedTransportMetadata> | undefined {
  const metadata = normalizedTransports.get(transport);
  if (
    maxBytes !== undefined &&
    metadata?.originalBytes !== undefined &&
    metadata.originalBytes > maxBytes
  ) {
    throw new SchemaError(
      "RESOURCE_LIMIT",
      "Original byte source exceeds the inherited maxBytes limit.",
    );
  }
  return metadata;
}

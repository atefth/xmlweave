import { parseXml, serializeXml } from './index.js';

export interface SchemaSignal { readonly aborted: boolean }
export interface SchemaOptions { signal?: SchemaSignal }
export interface SchemaDiagnostic {
  message: string;
  severity: 'warning' | 'error' | 'fatal';
  line?: number;
  column?: number;
  path?: string;
}
export type SchemaErrorCode = 'ABORTED' | 'ENGINE_UNAVAILABLE' | 'INVALID_SCHEMA' | 'INVALID_XML' | 'EXTERNAL_RESOURCE_FORBIDDEN' | 'DISPOSED' | 'ENGINE_ERROR';
export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  readonly diagnostics: readonly SchemaDiagnostic[];
  constructor(code: SchemaErrorCode, message: string, diagnostics: readonly SchemaDiagnostic[] = [], cause?: unknown) {
    super(message, { cause });
    this.name = 'SchemaError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
export interface SchemaValidationResult { valid: boolean; diagnostics: readonly SchemaDiagnostic[] }
export interface CompiledSchema {
  readonly disposed: boolean;
  validate(xml: string, options?: SchemaOptions): Promise<SchemaValidationResult>;
  dispose(): void;
}

const xsd = 'http://www.w3.org/2001/XMLSchema';
const xsi = 'http://www.w3.org/2001/XMLSchema-instance';
function checkSignal(options?: SchemaOptions): void {
  if (options?.signal?.aborted) throw new SchemaError('ABORTED', 'Schema operation was aborted.');
}
function diagnostics(cause: unknown): SchemaDiagnostic[] {
  if (cause && typeof cause === 'object' && 'details' in cause && Array.isArray(cause.details)) {
    return cause.details.map(detail => ({
      message: String(detail.message).trim(), severity: detail.level === 1 ? 'warning' : detail.level === 3 ? 'fatal' : 'error',
      ...(detail.line > 0 ? { line: detail.line } : {}), ...(detail.col > 0 ? { column: detail.col } : {}),
      ...(typeof detail.xpath === 'string' ? { path: detail.xpath } : {}),
    }));
  }
  return [{ message: cause instanceof Error ? cause.message : String(cause), severity: 'error' }];
}
function safeXml(xml: string, schema: boolean): string {
  let doc;
  try { doc = parseXml(xml); }
  catch (cause) { throw new SchemaError(schema ? 'INVALID_SCHEMA' : 'INVALID_XML', 'Expected well-formed XML without DTDs and within core resource limits.', diagnostics(cause), cause); }
  const root = doc.documentElement!;
  if (schema && (root.namespaceURI !== xsd || root.localName !== 'schema')) {
    throw new SchemaError('INVALID_SCHEMA', 'Expected an XSD 1.0 schema root.');
  }
  const stack = [root];
  while (stack.length) {
    const element = stack.pop()!;
    if ((element.namespaceURI === xsd && ['include', 'import', 'redefine', 'override'].includes(element.localName)) ||
        element.namespaceURI === 'http://www.w3.org/2001/XInclude') {
      throw new SchemaError('EXTERNAL_RESOURCE_FORBIDDEN', 'Schema composition and XInclude are forbidden; supply one self-contained schema.');
    }
    if (element.hasAttributeNS(xsi, 'schemaLocation') || element.hasAttributeNS(xsi, 'noNamespaceSchemaLocation')) {
      throw new SchemaError('EXTERNAL_RESOURCE_FORBIDDEN', 'Instance schema-location hints are forbidden; the compiled schema is authoritative.');
    }
    if (schema && element.namespaceURI === xsd && ['assert', 'alternative', 'openContent', 'defaultOpenContent'].includes(element.localName)) {
      throw new SchemaError('INVALID_SCHEMA', 'XSD 1.1 constructs are not supported.');
    }
    for (let i = 0; i < element.childNodes.length; i++) {
      const child = element.childNodes[i]!;
      if (child.nodeType === 1) stack.push(child as typeof element);
    }
  }
  return serializeXml(doc);
}

async function engine(options?: SchemaOptions) {
  checkSignal(options);
  try {
    const loaded = await import('libxml2-wasm');
    checkSignal(options);
    return loaded;
  } catch (cause) {
    if (cause instanceof SchemaError) throw cause;
    throw new SchemaError('ENGINE_UNAVAILABLE', 'Could not load the optional libxml2-wasm engine.', diagnostics(cause), cause);
  }
}
/** Initialize the optional WASM engine. It remains shared for the life of the JS realm. */
export async function loadSchemaEngine(options?: SchemaOptions): Promise<void> { await engine(options); }

/** Compile a self-contained XSD 1.0 schema; the caller owns and must dispose the result. */
export async function compileSchema(xml: string, options?: SchemaOptions): Promise<CompiledSchema> {
  checkSignal(options);
  const safe = safeXml(xml, true);
  const lib = await engine(options);
  let source: InstanceType<typeof lib.XmlDocument> | undefined;
  let validator: InstanceType<typeof lib.XsdValidator>;
  try {
    source = lib.XmlDocument.fromString(safe, { option: lib.ParseOption.XML_PARSE_NO_XXE | lib.ParseOption.XML_PARSE_NONET });
    validator = lib.XsdValidator.fromDoc(source);
  } catch (cause) {
    throw new SchemaError('INVALID_SCHEMA', 'XSD schema compilation failed.', diagnostics(cause), cause);
  } finally { source?.dispose(); }
  let disposed = false;
  return {
    get disposed() { return disposed; },
    async validate(input, validationOptions) {
      checkSignal(validationOptions);
      if (disposed) throw new SchemaError('DISPOSED', 'The compiled schema has been disposed.');
      const prepared = safeXml(input, false);
      let document: InstanceType<typeof lib.XmlDocument> | undefined;
      try {
        document = lib.XmlDocument.fromString(prepared, { option: lib.ParseOption.XML_PARSE_NO_XXE | lib.ParseOption.XML_PARSE_NONET });
        validator.validate(document);
        return { valid: true, diagnostics: [] };
      } catch (cause) {
        if (cause instanceof lib.XmlValidateError) return { valid: false, diagnostics: diagnostics(cause) };
        throw new SchemaError('ENGINE_ERROR', 'Schema validation failed internally.', diagnostics(cause), cause);
      } finally { document?.dispose(); }
    },
    dispose() {
      if (!disposed) { validator.dispose(); disposed = true; }
    },
  };
}

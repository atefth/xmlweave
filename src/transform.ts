import { parseXml, serializeXml } from './index.js';
import type { Element } from 'slimdom';
import { loadXslt } from './vendor-xslt.js';

export type TransformErrorCode = 'INVALID_ARGUMENT' | 'INVALID_STYLESHEET' | 'INVALID_XML' | 'UNSUPPORTED_FEATURE' | 'EXTERNAL_RESOURCE_FORBIDDEN' | 'ENGINE_UNAVAILABLE' | 'TRANSFORM_FAILED' | 'RESOURCE_LIMIT' | 'DISPOSED' | 'ABORTED';
export class TransformError extends Error {
  constructor(readonly code: TransformErrorCode, message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'TransformError'; }
}
export interface TransformOptions {
  parameters?: Readonly<Record<string, string | number | boolean>>;
  /** Result length cap, at most 1,000,000 UTF-16 code units. Checked after engine execution. */
  maxOutputLength?: number;
  /** Cooperative checkpoints only; cannot interrupt synchronous engine work. */
  signal?: { readonly aborted: boolean };
}
export interface CompiledStylesheet {
  readonly disposed: boolean;
  readonly outputMethod: 'xml' | 'text';
  transform(xml: string, options?: TransformOptions): Promise<string>;
  dispose(): void;
}
const XSL = 'http://www.w3.org/1999/XSL/Transform';
const instructions = new Set(['stylesheet', 'transform', 'template', 'output', 'param', 'variable', 'value-of', 'text', 'apply-templates', 'for-each', 'if', 'choose', 'when', 'otherwise', 'sort', 'attribute', 'element', 'copy', 'copy-of', 'number', 'call-template', 'with-param', 'strip-space', 'preserve-space', 'key', 'decimal-format']);
const functions = new Set(['node', 'text', 'comment', 'processing-instruction', 'position', 'last', 'count', 'string', 'concat', 'number', 'boolean', 'not', 'true', 'false', 'substring', 'substring-before', 'substring-after', 'contains', 'starts-with', 'normalize-space', 'translate', 'string-length', 'local-name', 'namespace-uri', 'name', 'sum', 'floor', 'ceiling', 'round', 'key', 'current', 'generate-id', 'format-number', 'lang', 'id']);
const expressionAttributes = new Set(['select', 'match', 'test', 'use', 'count', 'from', 'value']);

function checkpoint(options?: TransformOptions): void {
  if (options?.signal?.aborted) throw new TransformError('ABORTED', 'Transformation was aborted.');
}
function inspectExpression(expression: string, namespaces: ReadonlyMap<string, string>): void {
  // Remove quoted XPath strings first: apparent calls inside literal data are harmless.
  const unquoted = expression.replace(/'[^']*'|"[^"]*"/g, ' ');
  if (/[#?]|Q\{|\(:|=>/.test(unquoted)) throw new TransformError('UNSUPPORTED_FEATURE', 'Only the documented XPath 1.0 expression subset is supported.');
  for (const match of unquoted.matchAll(/([A-Za-z_][A-Za-z0-9_.-]*):(?:[A-Za-z_*])/g)) {
    if (!namespaces.has(match[1]!)) throw new TransformError('INVALID_STYLESHEET', `Unbound expression namespace prefix: ${match[1]}.`);
  }
  for (const match of unquoted.matchAll(/([A-Za-z_][A-Za-z0-9_.:-]*)\s*\(/g)) {
    const fn = match[1]!;
    if (fn === 'document' || fn === 'doc' || fn === 'unparsed-text' || fn === 'collection') throw new TransformError('EXTERNAL_RESOURCE_FORBIDDEN', 'Document loading functions are forbidden.');
    if (!functions.has(fn)) throw new TransformError('UNSUPPORTED_FEATURE', `Function ${fn} is outside the transformation subset.`);
  }
}
function inspectAvt(value: string, namespaces: ReadonlyMap<string, string>): void {
  let cursor = 0;
  while (cursor < value.length) {
    if (value.slice(cursor, cursor + 2) === '{{' || value.slice(cursor, cursor + 2) === '}}') { cursor += 2; continue; }
    if (value[cursor] !== '{') { cursor++; continue; }
    const start = ++cursor;
    let quote = '';
    for (; cursor < value.length; cursor++) {
      const ch = value[cursor]!;
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '}') break;
    }
    if (cursor === value.length) throw new TransformError('INVALID_STYLESHEET', 'Unclosed attribute value template.');
    inspectExpression(value.slice(start, cursor++), namespaces);
  }
}
function prepare(xml: string, stylesheet: boolean): ReturnType<typeof parseXml> {
  try { return parseXml(xml); }
  catch (cause) { throw new TransformError(stylesheet ? 'INVALID_STYLESHEET' : 'INVALID_XML', 'Expected bounded, well-formed XML without DTDs.', { cause }); }
}
function optionsFor(options?: TransformOptions): { parameters: { name: string; value: string | number | boolean }[]; maxLength: number } {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new TransformError('INVALID_ARGUMENT', 'Options must be an object.');
  const maxLength = options?.maxOutputLength ?? 1_000_000;
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 1_000_000) throw new TransformError('INVALID_ARGUMENT', 'maxOutputLength must be an integer from 1 to 1,000,000.');
  const parameters: { name: string; value: string | number | boolean }[] = [];
  const values = options?.parameters;
  if (values !== undefined) {
    if (!values || typeof values !== 'object' || Array.isArray(values) || ![Object.prototype, null].includes(Object.getPrototypeOf(values))) throw new TransformError('INVALID_ARGUMENT', 'Parameters must be a plain record.');
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(values))) {
      const value = descriptor.value as unknown;
      if (!('value' in descriptor) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || !(['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)))) throw new TransformError('INVALID_ARGUMENT', 'Parameters require unprefixed names and finite scalar values.');
      parameters.push({ name, value: value as string | number | boolean });
    }
  }
  return { parameters, maxLength };
}

/** Prepare the supported XSLT 1.0 subset. Use trusted stylesheets: this is not a CPU sandbox. */
export async function compileStylesheet(stylesheet: string): Promise<CompiledStylesheet> {
  const doc = prepare(stylesheet, true);
  const root = doc.documentElement!;
  if (root.namespaceURI !== XSL || !['stylesheet', 'transform'].includes(root.localName) || root.getAttribute('version') !== '1.0') throw new TransformError('UNSUPPORTED_FEATURE', 'An explicit XSLT 1.0 stylesheet root is required.');
  let method: 'xml' | 'text' = 'xml';
  let outputCount = 0;
  const namespaces = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);
  const elements: Element[] = [];
  const stack: Element[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    elements.push(el);
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i]!;
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/' && attr.prefix === 'xmlns') {
        const existing = namespaces.get(attr.localName);
        if (existing !== undefined && existing !== attr.value) throw new TransformError('UNSUPPORTED_FEATURE', 'Scoped prefix rebinding is unsupported; use a unique prefix for each namespace.');
        namespaces.set(attr.localName, attr.value);
      }
    }
    for (let i = 0; i < el.childNodes.length; i++) if (el.childNodes[i]!.nodeType === 1) stack.push(el.childNodes[i] as Element);
  }
  // The engine reads expression bindings from the stylesheet root. Normalize unique
  // scoped prefixes there; reject conflicts above instead of silently losing results.
  for (const [prefix, uri] of namespaces) if (prefix !== 'xml') root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, uri);
  for (const el of elements) {
    if (el.hasAttribute('extension-element-prefixes') || el.hasAttributeNS(XSL, 'extension-element-prefixes')) throw new TransformError('UNSUPPORTED_FEATURE', 'Extension elements are disabled.');
    if (el.namespaceURI === XSL) {
      if (['include', 'import', 'result-document'].includes(el.localName)) throw new TransformError('EXTERNAL_RESOURCE_FORBIDDEN', 'External stylesheets and secondary result documents are forbidden.');
      if (!instructions.has(el.localName)) throw new TransformError('UNSUPPORTED_FEATURE', `Unsupported XSLT instruction: ${el.localName}.`);
      if (el.getAttribute('disable-output-escaping') === 'yes') throw new TransformError('UNSUPPORTED_FEATURE', 'Disabling output escaping is forbidden.');
      if (el.localName === 'output') {
        if (++outputCount > 1 || el.parentNode !== root) throw new TransformError('UNSUPPORTED_FEATURE', 'Supply at most one top-level output declaration.');
        const declared = el.getAttribute('method') ?? 'xml';
        if (!['xml', 'text'].includes(declared) || el.hasAttribute('doctype-system') || el.hasAttribute('doctype-public') || el.hasAttribute('cdata-section-elements')) throw new TransformError('UNSUPPORTED_FEATURE', 'Only XML/text output without DTDs or CDATA overrides is supported.');
        method = declared as 'xml' | 'text';
      }
    }
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i]!;
      if (el.namespaceURI === XSL && expressionAttributes.has(attr.localName) && !attr.namespaceURI) inspectExpression(attr.value, namespaces);
      else inspectAvt(attr.value, namespaces);
    }
  }
  let safe = serializeXml(doc);
  let lib: Awaited<ReturnType<typeof loadXslt>>;
  try { lib = await loadXslt(); }
  catch (cause) { throw new TransformError('ENGINE_UNAVAILABLE', 'Install the optional xslt-processor 5.1.2 engine.', { cause }); }
  // Parse eagerly to establish compile-time diagnostics; execution uses fresh engine state.
  try { new lib.XmlParser().xmlParse(safe); }
  catch (cause) { throw new TransformError('INVALID_STYLESHEET', 'Stylesheet preparation failed.', { cause }); }
  let disposed = false;
  return {
    get disposed() { return disposed; }, outputMethod: method,
    async transform(input, options) {
      checkpoint(options);
      if (disposed) throw new TransformError('DISPOSED', 'Stylesheet has been disposed.');
      const settings = optionsFor(options);
      const xml = serializeXml(prepare(input, false));
      const parser = new lib.XmlParser();
      let deniedResource = false;
      const deny = (): never => { deniedResource = true; throw new TransformError('EXTERNAL_RESOURCE_FORBIDDEN', 'External resource resolution is forbidden.'); };
      const engine = new lib.Xslt({ cData: true, escape: method !== 'text', selfClosingTags: true, outputMethod: method, parameters: settings.parameters, fetchFunction: async () => deny(), documentLoader: () => deny() });
      let result: string;
      try { result = await engine.xsltProcess(parser.xmlParse(xml), parser.xmlParse(safe)); }
      catch (cause) {
        if (cause instanceof TransformError) throw cause;
        throw new TransformError('TRANSFORM_FAILED', 'Transformation failed.', { cause });
      }
      checkpoint(options);
      if (deniedResource) throw new TransformError('EXTERNAL_RESOURCE_FORBIDDEN', 'The engine attempted forbidden external resource resolution.');
      if (result.length > settings.maxLength) throw new TransformError('RESOURCE_LIMIT', 'Transformation result exceeds maxOutputLength.');
      if (method === 'xml') {
        try { parseXml(result); }
        catch (cause) { throw new TransformError('TRANSFORM_FAILED', 'XML output must be one well-formed document within core limits.', { cause }); }
      }
      return result;
    },
    dispose() { disposed = true; safe = ''; },
  };
}

export async function transformXml(xml: string, stylesheet: string, options?: TransformOptions): Promise<string> {
  checkpoint(options);
  const compiled = await compileStylesheet(stylesheet);
  try { return await compiled.transform(xml, options); }
  finally { compiled.dispose(); }
}

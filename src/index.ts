import * as dom from 'slimdom';
export type { Document, Element, Node, Attr, Text, Comment, CDATASection, ProcessingInstruction, DocumentFragment } from 'slimdom';

export type XmlErrorCode = 'MALFORMED_XML' | 'DTD_FORBIDDEN' | 'RESOURCE_LIMIT' | 'INVALID_ARGUMENT' | 'INVALID_DOCUMENT' | 'MUTATION_FAILED';
export type XmlOperation = 'parse' | 'create' | 'serialize' | 'mutate';

/** Failures from the facade. Direct DOM methods retain their engine exceptions. */
export class XmlError extends Error {
  readonly code: XmlErrorCode;
  readonly operation: XmlOperation;
  readonly line?: number;
  readonly column?: number;
  constructor(code: XmlErrorCode, operation: XmlOperation, message: string, options?: { cause?: unknown; line?: number; column?: number }) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'XmlError';
    this.code = code;
    this.operation = operation;
    this.line = options?.line;
    this.column = options?.column;
  }
}

export interface XmlOptions {
  /** Maximum UTF-16 code units in the source/result string, at most 1,000,000. */
  maxLength?: number;
  /** Maximum element nesting, at most 256. */
  maxDepth?: number;
  /** Maximum DOM nodes including document and attributes, at most 100,000. */
  maxNodes?: number;
}
const defaults = { maxLength: 1_000_000, maxDepth: 256, maxNodes: 100_000 } as const;
type Limits = { -readonly [K in keyof typeof defaults]: number };
function limits(options: XmlOptions | undefined, operation: XmlOperation): Limits {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
    throw new XmlError('INVALID_ARGUMENT', operation, 'Options must be an object.');
  }
  const result = { ...defaults } as Limits;
  for (const key of Object.keys(defaults) as (keyof Limits)[]) {
    const value = options?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key]) {
      throw new XmlError('INVALID_ARGUMENT', operation, `${key} must be an integer from 1 to ${defaults[key]}.`);
    }
    result[key] = value;
  }
  return result;
}

/** Scan markup boundaries before invoking a parser that otherwise accepts DTDs. */
function preflight(xml: string, policy: Limits): void {
  if (xml.length > policy.maxLength) throw new XmlError('RESOURCE_LIMIT', 'parse', 'XML input exceeds maxLength.');
  let cursor = 0;
  let depth = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start === -1) break;
    let end: number;
    if (xml.startsWith('<!--', start)) {
      end = xml.indexOf('-->', start + 4);
      cursor = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      end = xml.indexOf(']]>', start + 9);
      cursor = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', start)) {
      end = xml.indexOf('?>', start + 2);
      cursor = end === -1 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', start)) {
      const prefix = xml.slice(0, start).split(/\r\n|\r|\n/);
      throw new XmlError('DTD_FORBIDDEN', 'parse', 'DTDs and custom/external entities are not supported.', { line: prefix.length, column: prefix[prefix.length - 1]!.length + 1 });
    }
    // Skip the entire tag, respecting quoted attribute values.
    let quote = '';
    end = start + 1;
    for (; end < xml.length; end++) {
      const ch = xml[end]!;
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (xml[start + 1] === '/') depth = Math.max(0, depth - 1);
    else if (xml[start + 1] !== '!') {
      if (depth + 1 > policy.maxDepth) throw new XmlError('RESOURCE_LIMIT', 'parse', 'XML input exceeds maxDepth.');
      if (xml[end - 1] !== '/') depth++;
    }
    cursor = end + 1;
  }
}

function requireDocument(value: unknown, operation: XmlOperation): asserts value is dom.Document {
  if (!(value instanceof dom.Document)) throw new XmlError('INVALID_ARGUMENT', operation, 'Expected an XMLWeave document.');
}

/** Iterative traversal avoids sending deep or oversized user-mutated trees to the serializer. */
function inspect(doc: dom.Document, policy: Limits, operation: XmlOperation): void {
  const stack: { node: dom.Node; depth: number }[] = [{ node: doc, depth: 0 }];
  let count = 0;
  let contentLength = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > policy.maxNodes) throw new XmlError('RESOURCE_LIMIT', operation, 'Document exceeds maxNodes.');
    if (node.nodeType === 10) throw new XmlError('DTD_FORBIDDEN', operation, 'Document types are not supported.');
    const elementDepth = depth + (node.nodeType === 1 ? 1 : 0);
    if (elementDepth > policy.maxDepth) throw new XmlError('RESOURCE_LIMIT', operation, 'Document exceeds maxDepth.');
    // A lower bound on output size, checked before allocating the serialized string.
    contentLength += node.nodeValue?.length ?? 0;
    if (node.nodeType === 1) {
      const el = node as dom.Element;
      contentLength += el.nodeName.length;
      for (let a = 0; a < el.attributes.length; a++) {
        const attr = el.attributes[a]!;
        contentLength += attr.name.length + attr.value.length;
        if (++count > policy.maxNodes) throw new XmlError('RESOURCE_LIMIT', operation, 'Document exceeds maxNodes.');
      }
    }
    if (contentLength > policy.maxLength) throw new XmlError('RESOURCE_LIMIT', operation, 'Document content exceeds maxLength.');
    // Bound queued siblings too, instead of allocating an unbounded traversal stack.
    if (count + stack.length + node.childNodes.length > policy.maxNodes) throw new XmlError('RESOURCE_LIMIT', operation, 'Document exceeds maxNodes.');
    for (let n = node.childNodes.length - 1; n >= 0; n--) stack.push({ node: node.childNodes[n]!, depth: elementDepth });
  }
}

/** Parse one well-formed XML document. DTDs are always forbidden. */
export function parseXml(input: string, options?: XmlOptions): dom.Document {
  if (typeof input !== 'string') throw new XmlError('INVALID_ARGUMENT', 'parse', 'XML input must be a string.');
  const policy = limits(options, 'parse');
  preflight(input, policy);
  let doc: dom.Document;
  try { doc = dom.parseXmlDocument(input); }
  catch (cause) { throw new XmlError('MALFORMED_XML', 'parse', 'XML is not well formed.', { cause }); }
  inspect(doc, policy, 'parse');
  return doc;
}

/** Create an empty document or a document with a namespace-aware root. */
export function createDocument(namespaceURI: string | null = null, qualifiedName?: string): dom.Document {
  if ((namespaceURI !== null && typeof namespaceURI !== 'string') || (qualifiedName !== undefined && (typeof qualifiedName !== 'string' || !qualifiedName))) {
    throw new XmlError('INVALID_ARGUMENT', 'create', 'Expected a namespace string/null and an optional nonempty qualified name.');
  }
  if (qualifiedName === undefined && namespaceURI) throw new XmlError('INVALID_ARGUMENT', 'create', 'A namespace requires a qualified root name.');
  try {
    const doc = new dom.Document();
    if (qualifiedName !== undefined) doc.appendChild(doc.createElementNS(namespaceURI, qualifiedName));
    return doc;
  } catch (cause) { throw new XmlError('INVALID_ARGUMENT', 'create', 'Invalid root name or namespace.', { cause }); }
}

/** Serialize a complete document, enforcing well-formedness and resource limits. */
export function serializeXml(document: dom.Document, options?: XmlOptions): string {
  requireDocument(document, 'serialize');
  const policy = limits(options, 'serialize');
  inspect(document, policy, 'serialize');
  let xml: string;
  try { xml = dom.serializeToWellFormedString(document); }
  catch (cause) { throw new XmlError('INVALID_DOCUMENT', 'serialize', 'Document cannot be serialized as well-formed XML.', { cause }); }
  if (xml.length > policy.maxLength) throw new XmlError('RESOURCE_LIMIT', 'serialize', 'Serialized XML exceeds maxLength.');
  return xml;
}

/** Apply synchronous mutations and verify the result. Failure does not roll back changes. */
export function mutateXml(document: dom.Document, change: (document: dom.Document) => void, options?: XmlOptions): dom.Document {
  requireDocument(document, 'mutate');
  if (typeof change !== 'function') throw new XmlError('INVALID_ARGUMENT', 'mutate', 'Mutation must be a synchronous callback.');
  if (Object.prototype.toString.call(change) === '[object AsyncFunction]') throw new XmlError('INVALID_ARGUMENT', 'mutate', 'Asynchronous mutation callbacks are not supported.');
  limits(options, 'mutate');
  try {
    const result = change(document) as unknown;
    if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
      // Observe rejection from an unsupported Promise-returning callback.
      void Promise.resolve(result).catch(() => {});
      throw new XmlError('INVALID_ARGUMENT', 'mutate', 'Asynchronous mutation callbacks are not supported.');
    }
  } catch (cause) {
    if (cause instanceof XmlError && cause.operation === 'mutate') throw cause;
    throw new XmlError('MUTATION_FAILED', 'mutate', 'Mutation callback failed; changes are not rolled back.', { cause });
  }
  try { serializeXml(document, options); }
  catch (cause) {
    if (cause instanceof XmlError) throw new XmlError(cause.code, 'mutate', cause.message, { cause });
    throw cause;
  }
  return document;
}

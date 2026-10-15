import * as engine from 'fontoxpath';
import type { Node, Document, Element } from 'slimdom';

export type XPathErrorCode = 'INVALID_ARGUMENT' | 'RESOURCE_LIMIT' | 'UNSUPPORTED_FEATURE' | 'EVALUATION_FAILED';
export class XPathError extends Error {
  readonly code: XPathErrorCode;
  constructor(code: XPathErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'XPathError';
    this.code = code;
  }
}
export type XPathReturnType = 'nodes' | 'firstNode' | 'string' | 'number' | 'boolean';
export interface XPathResults {
  nodes: Node[];
  firstNode: Node | null;
  string: string;
  number: number;
  boolean: boolean;
}
export interface XPathOptions {
  /** Explicit prefix bindings; empty prefix sets the default element namespace. */
  namespaces?: Readonly<Record<string, string>>;
  /** Unprefixed scalar variables. Use variables instead of interpolating query text. */
  variables?: Readonly<Record<string, string | number | boolean | null>>;
  /** Query UTF-16 length cap; may lower the default of 10,000. Not a CPU timeout. */
  maxQueryLength?: number;
}
const FN = 'http://www.w3.org/2005/xpath-functions';
const XQX = 'http://www.w3.org/2005/XQueryX';
const knownNamespaces: Readonly<Record<string, string>> = {
  fn: FN,
  xs: 'http://www.w3.org/2001/XMLSchema',
  math: `${FN}/math`,
  map: `${FN}/map`,
  array: `${FN}/array`,
  xml: 'http://www.w3.org/XML/1998/namespace',
};
const functionNamespaces = new Set([FN, knownNamespaces.xs, knownNamespaces.math, knownNamespaces.map, knownNamespaces.array]);
const forbiddenFunctions = new Set([
  'doc', 'doc-available', 'collection', 'uri-collection', 'unparsed-text', 'unparsed-text-lines',
  'unparsed-text-available', 'environment-variable', 'available-environment-variables',
  'trace', 'put', 'parse-xml', 'parse-xml-fragment', 'transform', 'load-xquery-module', 'function-lookup', 'json-doc',
]);
const returnTypes = {
  nodes: engine.evaluateXPath.NODES_TYPE,
  firstNode: engine.evaluateXPath.FIRST_NODE_TYPE,
  string: engine.evaluateXPath.STRING_TYPE,
  number: engine.evaluateXPath.NUMBER_TYPE,
  boolean: engine.evaluateXPath.BOOLEAN_TYPE,
};
const own = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const namePattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new XPathError('INVALID_ARGUMENT', `${label} must be a plain record.`);
  }
  // Do not execute option getters while copying a caller's record.
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new XPathError('INVALID_ARGUMENT', `${label} cannot contain accessors.`);
  }
  return value as Record<string, unknown>;
}

/** Inspect the parsed tree, including named function references and unreachable branches. */
function inspectQuery(ast: Element, namespaces: Record<string, string>): void {
  const stack: Node[] = [ast];
  let count = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (++count > 50_000) throw new XPathError('RESOURCE_LIMIT', 'Query syntax tree is too large.');
    if (node.nodeType === 1) {
      const element = node as Element;
      // Named calls/references use functionName, but named arrow targets use EQName.
      // Inspect both representations before evaluation, even in unreachable branches.
      const isArrowTarget = element.localName === 'EQName' && element.parentNode?.nodeType === 1 &&
        (element.parentNode as Element).namespaceURI === XQX && (element.parentNode as Element).localName === 'arrowExpr';
      if (element.namespaceURI === XQX && (element.localName === 'functionName' || isArrowTarget)) {
        const prefix = element.getAttributeNS(XQX, 'prefix') ?? '';
        const uri = element.getAttributeNS(XQX, 'URI') ?? (prefix ? namespaces[prefix] : FN);
        const localName = element.textContent ?? '';
        if (!uri || !functionNamespaces.has(uri) || (uri === FN && forbiddenFunctions.has(localName))) {
          throw new XPathError('UNSUPPORTED_FEATURE', `Function ${prefix ? `${prefix}:` : ''}${localName} is outside the read-only XPath policy.`);
        }
      }
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
}

/** Evaluate read-only XPath 3.1 over an XMLWeave DOM; defaults to a node sequence. */
export function evaluateXPath(expression: string, context: Node, options?: XPathOptions & { returnType?: 'nodes' }): Node[];
export function evaluateXPath<T extends XPathReturnType>(expression: string, context: Node, options: XPathOptions & { returnType: T }): XPathResults[T];
export function evaluateXPath(
  expression: string,
  context: Node,
  options?: XPathOptions & { returnType?: XPathReturnType },
): XPathResults[XPathReturnType] {
  if (typeof expression !== 'string') throw new XPathError('INVALID_ARGUMENT', 'XPath must be a nonempty string.');
  const settings = options === undefined ? {} : record(options, 'Options');
  const maxLength = settings.maxQueryLength === undefined ? 10_000 : settings.maxQueryLength;
  if (typeof maxLength !== 'number' || !Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 10_000) {
    throw new XPathError('INVALID_ARGUMENT', 'maxQueryLength must be an integer from 1 to 10,000.');
  }
  if (expression.length > maxLength) throw new XPathError('RESOURCE_LIMIT', 'XPath exceeds maxQueryLength.');
  if (!expression.trim()) throw new XPathError('INVALID_ARGUMENT', 'XPath must be a nonempty string.');
  const resultType = settings.returnType === undefined ? 'nodes' : settings.returnType;
  if (typeof resultType !== 'string' || !own(returnTypes, resultType)) throw new XPathError('INVALID_ARGUMENT', 'Unknown XPath returnType.');
  if (!context || typeof context !== 'object' || ![1, 2, 3, 4, 7, 8, 9].includes(context.nodeType)) {
    throw new XPathError('INVALID_ARGUMENT', 'XPath context must be a DOM node.');
  }
  const document = (context.nodeType === 9 ? context : context.ownerDocument) as Document | null;
  if (!document || typeof document.createElementNS !== 'function') throw new XPathError('INVALID_ARGUMENT', 'XPath context requires an owner document.');
  const namespaces: Record<string, string> = Object.assign(Object.create(null), knownNamespaces);
  if (settings.namespaces !== undefined) {
    for (const [prefix, value] of Object.entries(record(settings.namespaces, 'Namespaces'))) {
      if ((prefix !== '' && !namePattern.test(prefix)) || typeof value !== 'string' || (own(knownNamespaces, prefix) && value !== knownNamespaces[prefix])) {
        throw new XPathError('INVALID_ARGUMENT', 'Namespace bindings require valid prefixes and string URIs; standard prefixes cannot be rebound.');
      }
      namespaces[prefix] = value;
    }
  }
  const variables: Record<string, string | number | boolean | null> = Object.create(null);
  if (settings.variables !== undefined) {
    for (const [name, value] of Object.entries(record(settings.variables, 'Variables'))) {
      if (!namePattern.test(name) || !(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
        throw new XPathError('INVALID_ARGUMENT', 'Variables require unprefixed ASCII names and finite scalar values or null.');
      }
      variables[name] = value as string | number | boolean | null;
    }
  }
  const engineOptions = {
    language: engine.evaluateXPath.XPATH_3_1_LANGUAGE,
    namespaceResolver: (prefix: string) => namespaces[prefix] ?? null,
    disableCache: true,
    logger: { trace: () => { throw new XPathError('UNSUPPORTED_FEATURE', 'Tracing is disabled.'); } },
  };
  try {
    // parseScript produces a detached AST using the existing document factory: no second DOM runtime.
    const ast = engine.parseScript(expression, { ...engineOptions, annotateAst: false }, document) as unknown as Element;
    inspectQuery(ast, namespaces);
    return engine.evaluateXPath(ast, context, null, variables, returnTypes[resultType as XPathReturnType], engineOptions) as XPathResults[XPathReturnType];
  } catch (cause) {
    if (cause instanceof XPathError) throw cause;
    throw new XPathError('EVALUATION_FAILED', 'XPath parsing, static typing or evaluation failed.', { cause });
  }
}

function returning<T extends XPathReturnType>(options: XPathOptions | undefined, returnType: T): XPathOptions & { returnType: T } {
  return { ...(options === undefined ? {} : record(options, 'Options')), returnType };
}
export const evaluateXPathToNodes = (expression: string, context: Node, options?: XPathOptions): Node[] => evaluateXPath(expression, context, returning(options, 'nodes'));
export const evaluateXPathToFirstNode = (expression: string, context: Node, options?: XPathOptions): Node | null => evaluateXPath(expression, context, returning(options, 'firstNode'));
export const evaluateXPathToString = (expression: string, context: Node, options?: XPathOptions): string => evaluateXPath(expression, context, returning(options, 'string'));
export const evaluateXPathToNumber = (expression: string, context: Node, options?: XPathOptions): number => evaluateXPath(expression, context, returning(options, 'number'));
export const evaluateXPathToBoolean = (expression: string, context: Node, options?: XPathOptions): boolean => evaluateXPath(expression, context, returning(options, 'boolean'));

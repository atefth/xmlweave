import { SaxesParser, type SaxesTagNS } from './vendor-saxes.js';

export interface StreamName { readonly name: string; readonly localName: string; readonly prefix: string; readonly namespaceURI: string }
export interface StreamAttribute extends StreamName { readonly value: string }
export type XmlStreamEvent =
  | ({ readonly type: 'startElement'; readonly attributes: readonly StreamAttribute[]; readonly namespaces: Readonly<Record<string, string>> } & StreamName)
  | ({ readonly type: 'endElement' } & StreamName)
  | { readonly type: 'text' | 'cdata' | 'comment'; readonly value: string }
  | { readonly type: 'processingInstruction'; readonly target: string; readonly value: string }
  | { readonly type: 'declaration'; readonly version?: string; readonly encoding?: string; readonly standalone?: string };

/** Structural subset: importing this module does not require DOM or Node ambient types. */
export interface StreamAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
export interface XmlStreamOptions {
  /** Maximum source chunk in UTF-16 code units (default 65,536). */
  maxChunkLength?: number;
  /** Maximum input consumed between emitted events (default 65,536). */
  maxTokenLength?: number;
  /** Maximum complete source size in UTF-16 code units (default 100,000,000). */
  maxInputLength?: number;
  /** Maximum nested element depth (default 256). */
  maxDepth?: number;
  /** Maximum event queue (default 4). A self-closing tag requires two slots. */
  maxBufferedEvents?: number;
  signal?: StreamAbortSignal;
}
export type XmlStreamErrorCode = 'INVALID_ARGUMENT' | 'MALFORMED_XML' | 'DTD_FORBIDDEN' | 'RESOURCE_LIMIT' | 'ABORTED' | 'SOURCE_ERROR';
export class XmlStreamError extends Error {
  constructor(readonly code: XmlStreamErrorCode, message: string, readonly line?: number,
    readonly column?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'XmlStreamError';
  }
}

function name(tag: SaxesTagNS): StreamName {
  return { name: tag.name, localName: tag.local, prefix: tag.prefix, namespaceURI: tag.uri };
}

/** Incremental, pull-driven XML 1.0 events. Previously yielded events are provisional until EOF succeeds. */
export async function* streamXml(source: AsyncIterable<string> | Iterable<string>, options: XmlStreamOptions = {}): AsyncGenerator<XmlStreamEvent> {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new XmlStreamError('INVALID_ARGUMENT', 'Options must be an object.');
  const bounds = { maxChunkLength: 65_536, maxTokenLength: 65_536, maxInputLength: 100_000_000, maxDepth: 256, maxBufferedEvents: 4 };
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    const value = options[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1) throw new XmlStreamError('INVALID_ARGUMENT', `${key} must be a positive safe integer.`);
      bounds[key] = value;
    }
  }
  const signal = options.signal;
  if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new XmlStreamError('INVALID_ARGUMENT', 'Invalid abort signal.');
  }
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
  const fail = (code: XmlStreamErrorCode, message: string, cause?: unknown): XmlStreamError =>
    new XmlStreamError(code, message, parser.line, parser.column + 1, { cause });
  const aborted = (): XmlStreamError => fail('ABORTED', 'XML streaming was aborted.', signal?.reason);
  const queue: XmlStreamEvent[] = [];
  let buffered = 0;
  let depth = 0;
  const emit = (event: XmlStreamEvent): void => {
    if (queue.length >= bounds.maxBufferedEvents) throw fail('RESOURCE_LIMIT', 'Event buffer exceeds maxBufferedEvents.');
    queue.push(event);
    buffered = 0;
  };
  parser.on('error', cause => { throw fail('MALFORMED_XML', 'Malformed streaming XML.', cause); });
  parser.on('doctype', () => { throw fail('DTD_FORBIDDEN', 'DTDs and custom/external entities are forbidden.'); });
  parser.on('xmldecl', declaration => {
    if (declaration.version !== '1.0') throw fail('MALFORMED_XML', 'Only XML 1.0 is supported.');
    emit({ type: 'declaration', ...declaration });
  });
  parser.on('opentag', tag => {
    if (++depth > bounds.maxDepth) throw fail('RESOURCE_LIMIT', 'Element nesting exceeds maxDepth.');
    emit({ type: 'startElement', ...name(tag),
      attributes: Object.values(tag.attributes).map(attribute => ({ name: attribute.name, localName: attribute.local,
        prefix: attribute.prefix, namespaceURI: attribute.uri, value: attribute.value })),
      namespaces: { ...tag.ns } });
  });
  parser.on('closetag', tag => { emit({ type: 'endElement', ...name(tag) }); depth--; });
  parser.on('text', value => emit({ type: 'text', value }));
  parser.on('cdata', value => emit({ type: 'cdata', value }));
  parser.on('comment', value => emit({ type: 'comment', value }));
  parser.on('processinginstruction', instruction => emit({ type: 'processingInstruction', target: instruction.target, value: instruction.body }));

  let iterator: AsyncIterator<string> | Iterator<string> | undefined;
  let complete = false;
  try {
    if (signal?.aborted) throw aborted();
    if (source === null || source === undefined) throw fail('INVALID_ARGUMENT', 'Source must be an iterable of strings.');
    const asyncFactory = source[Symbol.asyncIterator as keyof typeof source] as (() => AsyncIterator<string>) | undefined;
    const factory = (asyncFactory ?? source[Symbol.iterator as keyof typeof source]) as (() => AsyncIterator<string> | Iterator<string>) | undefined;
    if (typeof factory !== 'function') throw fail('INVALID_ARGUMENT', 'Source must be an iterable of strings.');
    iterator = factory.call(source);
    if (!iterator || typeof iterator.next !== 'function') throw fail('INVALID_ARGUMENT', 'Invalid source iterator.');
    let total = 0;
    for (;;) {
      if (signal?.aborted) throw aborted();
      let removeListener: (() => void) | undefined;
      let result: IteratorResult<string>;
      try {
        const pending = Promise.resolve(iterator.next());
        if (signal) {
          const cancelled = new Promise<never>((_, reject) => {
            const listener = (): void => reject(aborted());
            signal.addEventListener('abort', listener, { once: true });
            removeListener = () => signal.removeEventListener('abort', listener);
            if (signal.aborted) listener();
          });
          result = await Promise.race([pending, cancelled]);
        } else result = await pending;
      } catch (cause) {
        if (cause instanceof XmlStreamError) throw cause;
        throw fail('SOURCE_ERROR', 'XML input source failed.', cause);
      } finally { removeListener?.(); }
      if (signal?.aborted) throw aborted();
      if (!result || typeof result !== 'object') throw fail('SOURCE_ERROR', 'Source returned an invalid iterator result.');
      if (result.done) break;
      const chunk = result.value;
      if (typeof chunk !== 'string') throw fail('INVALID_ARGUMENT', 'Source chunks must be strings.');
      if (chunk.length > bounds.maxChunkLength) throw fail('RESOURCE_LIMIT', 'Source chunk exceeds maxChunkLength.');
      total += chunk.length;
      if (total > bounds.maxInputLength) throw fail('RESOURCE_LIMIT', 'Source exceeds maxInputLength.');
      // Feed one UTF-16 unit: at most a constant number of events can be queued.
      // Saxes carries incomplete surrogate pairs and entity references across writes.
      for (let index = 0; index < chunk.length; index++) {
        if (signal?.aborted) throw aborted();
        if (++buffered > bounds.maxTokenLength) throw fail('RESOURCE_LIMIT', 'Unemitted input exceeds maxTokenLength.');
        parser.write(chunk[index]);
        while (queue.length) {
          if (signal?.aborted) throw aborted();
          yield queue.shift()!;
        }
      }
    }
    parser.close();
    while (queue.length) {
      if (signal?.aborted) throw aborted();
      yield queue.shift()!;
    }
    complete = true;
  } catch (cause) {
    if (cause instanceof XmlStreamError) throw cause;
    throw fail('SOURCE_ERROR', 'XML input source failed.', cause);
  } finally {
    if (!complete && iterator?.return) {
      // A pending next() in an arbitrary source cannot be forcibly interrupted.
      // On abort, request cleanup without waiting indefinitely for that source.
      try {
        const cleanup = Promise.resolve(iterator.return());
        if (signal?.aborted) void cleanup.catch(() => {});
        else await cleanup;
      } catch { /* Keep the parsing/source failure as the primary diagnostic. */ }
    }
  }
}

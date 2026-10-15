# Incremental XML events

`xmlweave/stream` is an optional entry point distinct from the DOM parser. It consumes `AsyncIterable<string>` or `Iterable<string>` and yields typed events as markup arrives, before source EOF. It never constructs a DOM or retains the whole document. Strings are already decoded; byte streams need an application adapter with a streaming decoder. No Node or browser ambient types are needed to import its public declarations.

```ts
import { streamXml } from 'xmlweave/stream';

async function* chunks() {
  yield '<p:root xmlns:p="urn:example">';
  yield '<p:item>A&amp;B</p:item>';
  yield '</p:root>';
}
for await (const event of streamXml(chunks())) {
  if (event.type === 'startElement') {
    // Expanded names are authoritative; name/prefix preserve lexical names.
    console.log(event.namespaceURI, event.localName, event.attributes);
  }
}
```

Events are `startElement`, `endElement`, `text`, `cdata`, `comment`, `processingInstruction`, and `declaration`. Element and attribute names expose `name`, `prefix`, `localName`, `namespaceURI`; no namespace is the empty string. `attributes` includes namespace declaration attributes; `namespaces` contains declarations made on that element (not a complete inherited map). Self-closing elements produce start and end events. Attribute values and text decode predefined/numeric XML entities and normalize XML line endings. CDATA is separate from ordinary text. Text event boundaries are an implementation detail; combine adjacent text events when needed. There are no artificial source-chunk events. UTF-16 surrogate pairs, names, comments, CDATA, attributes and entity references may span chunks. XML 1.0 only; XML 1.1 declarations fail.

Events already yielded are provisional: a later chunk or EOF may invalidate the document. Successful completion of iteration is the well-formedness result. Consumers that perform side effects must decide how to handle later errors.

## Bounds, backpressure and cancellation

Options default to `maxChunkLength: 65_536`, `maxTokenLength: 65_536`, `maxInputLength: 100_000_000` UTF-16 code units, `maxDepth: 256`, `maxBufferedEvents: 4`. Each must be a positive safe integer and may be tuned. `maxTokenLength` counts input consumed since the last emitted event: it bounds unfinished text, attributes, tags, comments, declarations and CDATA rather than splitting lexical tokens into invalid fragments. Oversize values fail with `RESOURCE_LIMIT`; a self-closing element requires two event-buffer slots. Input chunk allocations belong to the source, and a source can allocate an oversized string before the wrapper rejects it.

The wrapper feeds the engine one UTF-16 unit at a time and drains its bounded event queue before feeding more input. It holds at most one source chunk, a bounded pending lexical token, the bounded event queue and namespace/element state proportional to configured depth and token limits. Consumer-retained events and source-owned buffers are outside this bound. Character-wise feeding intentionally trades throughput for strict queue/token bounds. No CPU deadline or constant absolute RSS claim is made; JavaScript garbage collection and engine overhead vary.

No new source chunk is pulled until the current chunk's events are consumed. `break` or an explicit iterator `return()` invokes the source iterator's `return()`; parse/source errors also request cleanup. `signal` accepts a structural AbortSignal subset. Abort rejects a pending `next()` promptly, removes the listener and invokes source `return()`, observing any rejection without indefinitely awaiting cleanup. JavaScript cannot forcibly cancel an arbitrary pending source promise: the producer must cooperate with the same signal to actually interrupt I/O and finish cleanup. A consumer calling `return()` while its generator `next()` is pending also needs to abort that pending read; ordinary async-generator scheduling cannot interrupt it.

`XmlStreamError` exposes `code`, `cause` and optional one-based `line`/`column` parser positions (columns count Unicode characters, not UTF-16 units). Codes are `INVALID_ARGUMENT`, `MALFORMED_XML`, `DTD_FORBIDDEN`, `RESOURCE_LIMIT`, `ABORTED`, `SOURCE_ERROR`. DTD callbacks reject the declaration before any document entity-reference processing; custom/external entities cannot be resolved, no resolver exists, and undefined references fail instead of disappearing. DTD-looking text in comments/CDATA is data. An unfinished or oversized declaration may fail as malformed/resource-limited before its completed DTD callback.

## Engine decision and evidence (2026-10-15)

We evaluated real incremental writes in three pinned candidates, including one-code-unit chunk splits and full attribute/entity decoding where optional. Upstream maintenance was checked independently of correctness:

| Candidate | License / maintenance | Probe result / decision |
| --- | --- | --- |
| [saxes 6.0.0](https://github.com/lddubeau/saxes) | ISC; repository archived 2025-12-31 | Rejects duplicate raw and expanded attributes, unknown entities, NUL/reference-to-NUL, unbound prefixes and multiple roots. Selected for this explicit optional companion with its maintenance risk documented. |
| [sax 1.6.1](https://github.com/isaacs/sax-js) | BlueOak-1.0.0; unarchived, last push observed 2026-07-24 | Strict namespace mode still accepts duplicate raw/expanded attributes, literal NUL and multiple roots. No-go without substantial extra validation. |
| [saxen 11.2.0](https://github.com/nikku/saxen) | MIT; unarchived, last push observed 2026-09-30 | Even using attribute getters and decode callbacks, accepts duplicate expanded attributes, NUL and multiple roots; unknown entities remain verbatim and `&#0;` decodes to NUL. No-go for this well-formedness contract. Raw duplicate attributes are caught only when the attribute getter is read. |

Selecting archived saxes was a deliberate correctness tradeoff after maintained alternatives failed these gates, not an automatic default. Reevaluate on security reports, engine updates or a maintained candidate passing the corpus. Keep this decision separate from the slimdom synchronous core. saxes and its `xmlchars` dependency are pure JavaScript (ISC/MIT respectively); no native APIs are needed. The parent package bundles these dependencies for Node and browser consumers, with complete dependency license notices retained. Browser portability must be checked in the actual packed/browser fixture rather than inferred from pure JavaScript alone.

Upstream saxes 6.0.0 declarations contain unconstrained event-handler generics rejected by strict TypeScript 7. `src/vendor-saxes.js` is a runtime-only bridge; its adjacent local structural declaration describes just the pinned surface we exercise. Public stream declarations do not reference saxes, Node or browser types. This keeps `skipLibCheck: false` without globally suppressing or changing upstream declarations. Any engine upgrade requires validating this structural bridge against runtime tests.

A separate wrapper run increased the same generator to 1,000,000 records / 29 MB UTF-8 without retaining events: 3,000,002 events in 5,078.9 ms, sampled RSS 38.1→45.6 MiB. This tenfold input increase with modest sampled RSS growth supports incremental consumption; it does not establish a hard RSS ceiling.

An original generated fixture contained 100,000 `<i a="x">😀 &amp; value</i>` records inside `<r>`, delivered as 1,000 chunks of 100 records. On Windows x64 / Node 22.17.1, separate-process engine probes on 2.900007 MB UTF-8 (namespace mode, attributes/text processed) measured saxes 54.3 ms / sampled RSS 48.4→50.7 MiB, sax 112.8 ms / 45.7→49.6 MiB, saxen 69.7 ms / 44.4→50.2 MiB. The pull-driven wrapper yielded 300,002 events in 517.2 ms with sampled RSS 39.9→42.8 MiB. These are one local observational run, not statistically rigorous benchmarks or portable performance promises. Engine runs feed 100-record chunks directly; wrapper runs use bounded character feeds and async yields, so they deliberately include different overhead. RSS was sampled between batches and can miss peaks. The committed large-record test reproduces the wrapper fixture and emits timing/RSS diagnostics without retaining events or asserting flaky timing/RSS thresholds. Correctness, bounded token/chunk/depth/queue failures, every split point, early exit, backpressure, source failures and pending-read abort are regression tests.

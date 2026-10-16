# Isolated incremental Xerces validation

Import `compileIsolatedXercesSchema` from `xmlweave/schema-xerces-isolated` to compile an XSD 1.0 resource graph in a private worker/WASM realm. Every compiled grammar owns its worker; dispose it when finished. This is an alternative to the same-realm Xerces companion when native work needs a hard deadline.

```js
const grammar = await compileIsolatedXercesSchema(
  {kind: 'text', text: rootXsd, systemId: 'https://schemas.example/root.xsd'},
  {resourceMap: {'https://schemas.example/types.xsd': typesXsd}, timeoutMs: 30000}
);
try {
  for await (const event of grammar.validateStream(xmlChunks)) {
    // Native type and attribute snapshots are immutable.
    // Output is provisional until the final result, including late keyref errors.
  }
} finally { grammar.dispose(); }
```

The host preloads a bounded graph with the shared XML-aware schema graph policy. Includes, imports, redefinitions, namespace catalogues and explicit resolvers retain native component semantics. Resource identifiers never trigger implicit filesystem/network access. All schema dependencies are preflighted for DTDs, XInclude, unsupported XSD 1.1 constructs and graph budgets before transfer. The public compilation deadline also covers graph/resolver waits. Expiry rejects the operation and cancels downstream work; application-owned resolver promises themselves cannot be forcibly resumed or cancelled.

`validate` accepts the portable buffered text/byte/DOM/chunk source union. `validateStream` consumes decoded string chunks incrementally: each native read requests upstream input, and each output event requires consumer acknowledgement before the worker continues. One input chunk plus native parser buffers and one acknowledged event may be resident; this is bounded read-ahead rather than strict one-event/one-chunk equivalence. Neither the transport nor parser adapter accumulates the whole XML document. Identity-constraint tables can still grow with document content.

`timeoutMs` bounds worker compilation or the complete validation episode, including time awaiting application input or a slow consumer. Expiry, cancellation, callback failure, source failure, consumer early return and explicit disposal terminate the worker and invalidate the grammar. They also request upstream iterator closure; an application producer permanently blocked inside its own promise cannot be forcibly resumed. Source and observer exceptions retain their identity. Already-aborted calls and malformed iterators fail before starting an episode and preserve a healthy handle. Concurrent episodes on one handle reject with `BUSY`; separate handles have independent workers and resource catalogues.

Character, byte and diagnostic limits follow the portable source policy, with explicitly set inherited limits only allowed to decrease. `onDiagnostic` runs on the host and receives immutable native diagnostics. Compile observers are not inherited by validation. `errorPolicy: 'throw'` still observes diagnostics, then throws on completed invalidity; ordinary invalid XML does not invalidate the grammar. Other operational interruptions do. Buffered validation diagnostics retain original/generated source provenance; direct streaming input has chunk/original provenance.

Compile-time `typeQueries` use the same native derivation queries as the raw Xerces provider; retained PSVI, anonymous-type and derivation snapshots survive worker disposal because no native pointers leave the realm. No separately generated output XML/DOM method is exposed here; use the common output pipeline with the genuine native events.

Node resolves the packaged worker automatically. Browsers require an explicit `workerURL` pointing to the packaged module-worker asset. The worker loads the adjacent native runtime factory and engine JavaScript/WASM assets; optional `wasmUrl` overrides WASM location. Preserve their relative layout, serve appropriate JavaScript/WASM MIME types and configure CORS/CSP for module workers and WebAssembly. No page import map or bare optional peer is required by this worker.

Node tests prove native graph isolation, type/derivation snapshots, early invalid-child diagnostics, late keyref failure and worker termination. The packaged suite has run native workers in Chromium, Firefox and WebKit, including selected unchanged corpus cases, native diagnostics, handler gating and resource policies. The current completed-run counts and pending final integration checks are recorded in the [acceptance ledger](validation-status.md). `isolatedXercesCapabilities` describes delivered mechanisms, not universal XSD certification or a promise of constant native memory usage.

## Exact diagnostic decisions

`diagnosticHandler` is separate from the asynchronous `onDiagnostic` observer. It may return normally or return a promise, including during native compilation:

```js
const grammar = await compileIsolatedXercesSchema(source, {
  diagnosticHandler: async diagnostic => {
    if (diagnostic.severity === 'warning') return;
    throw new Error(diagnostic.message);
  }
});
```

The worker sends each native diagnostic and waits on a fresh per-episode shared control buffer. The main thread calls or awaits the handler and acknowledges through shared atomics; the main thread never calls `Atomics.wait`. Native parsing cannot advance beyond that diagnostic until the handler completes. Normal return continues recoverable errors and warnings; fatal diagnostics remain terminal. Thrown or rejected values retain their identity, including `undefined`, other falsy values and non-Error objects. A handler is called for every native diagnostic even after the retained-diagnostic cap is reached. Native source/security preflight failures remain operational errors, rather than synthetic engine diagnostics.

Node supports the shared-memory handshake. Browser exact handlers additionally require `SharedArrayBuffer` and `crossOriginIsolated`, normally enabled by these HTTP response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Worker/native assets must satisfy the resulting same-origin or CORS/CORP resource policy. Requesting an exact handler without these prerequisites rejects with `UNSUPPORTED_CAPABILITY` before consuming source input. It never silently becomes an observer. Other APIs and ordinary observers do not require cross-origin isolation.

A pending handler is covered by the operation deadline and cancellation. Timeout, abort or disposal terminates a worker blocked in its shared-memory wait. Completion of an old handler after termination cannot acknowledge a later episode. Application handler promises themselves cannot be forcibly cancelled. Compile handlers, observers, signals and error policy are not inherited by subsequent validation episodes; pass an operation handler explicitly. Processing budgets and engine settings remain immutable compile configuration.

Node tests cover genuine native error gating, retained-cap overflow, stopping before another producer chunk, compilation and validation callback exceptions, pending handler timeout/abort/disposal, and stale completion. Synthetic worker-boundary warning/fatal tests are identified as transport evidence; they are not represented as an observed warning-producing native XSD condition. The packed browser fixture serves actual COOP/COEP headers, verifies asynchronous gating with real native diagnostics, and separately verifies rejection on a page without cross-origin isolation.

For buffered `validate` sources, `maxBytes` measures the original byte source during decoding. Native UTF-8 transport uses its separate fixed ceiling after normalization, so transcoding Latin-1 does not incorrectly spend the original-byte budget twice. Direct string-chunk `validateStream` budgets apply to the emitted UTF-8 stream.

## Retained type derivation queries

Every reported native type snapshot carries an immutable `identity` containing its owning `schemaIdentity` and QName. Anonymous types receive stable generated QNames within that compiled grammar; they are not application schema declarations and are not portable identifiers for another grammar. Repeated snapshots from the same retained type reuse its identity.

```js
const derived = await grammar.queryTypeDerivation(
  elementType.identity,
  {namespaceURI: 'http://www.w3.org/2001/XMLSchema', name: 'decimal'},
  1,
  {timeoutMs: 1000}
);
```

The query uses the actual retained native type graph after validation. Method masks follow DOM derivation methods: restriction 1, extension 2, union 4, list 8; zero accepts any derivation. The ancestor is a plain QName. The queried type must have been reported by this grammar; foreign or unknown identities reject with `INVALID_ARGUMENT` without invalidating a healthy handle. Queries are permitted only between episodes, reject with `BUSY` during validation or another query, and reject with `DISPOSED` after disposal.

Queries have their own worker request identity, deadline and optional structural cancellation signal. Timeout, abort or disposal terminate the worker. A retained snapshot remains readable after disposal, but it cannot query freed native data. A grammar's anonymous identity cannot be transferred to a different worker or reconstructed as a cross-compilation cache key.

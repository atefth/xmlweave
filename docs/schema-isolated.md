# Legacy isolated schema graphs

`xmlweave/schema-isolated` compiles explicit XSD 1.0 source sets in a dedicated worker and independent libxml2-wasm realm. Each returned grammar owns one worker; always call `dispose()`. This is an explicit compatibility companion, not the default validator. Install `libxml2-wasm@0.7.2` to use it. Prefer [native isolated validation](schema-xerces-isolated.md) for the current conformance/streaming/type contract: the legacy engine accepted an invalid base64 value in the tracked differential fixture.

```js
import { compileIsolatedSchema } from 'xmlweave/schema-isolated';
const grammar = await compileIsolatedSchema(
  { kind: 'text', text: rootXsd, systemId: 'https://schemas.example/main.xsd' },
  { resourceMap: { 'https://schemas.example/types.xsd': typesXsd }, timeoutMs: 30000 }
);
try { console.log(await grammar.validate('<order/>')); }
finally { grammar.dispose(); }
```

Identifiers do not trigger fetching. All dependencies must come from a snapshotted resource map or an explicitly supplied asynchronous resolver. Resolver requests expose kind, namespace, original system identifier, base URI and canonical requested URI. Unresolved resources fail closed, including native requests that the engine would otherwise treat as warnings. Resolver exceptions retain their identity. Loaded dependencies are XML-aware preflighted; DTDs, XInclude and XSD 1.1 constructs are rejected. Explicit grammar mode rejects instance schema hints.

Includes, imports and redefinitions use the native component compiler. Relative locations use each document's canonical URL. Namespace-only imports require a namespace catalogue (`namespaceCatalog: { 'urn:types': 'https://schemas.example/types.xsd' }`) or an unambiguous matching schema-set source. Multiple sources are assembled with generated include/import entry schemas, including multiple roots in one namespace. This does not concatenate schema components. Legitimate resource cycles are deduplicated, while chameleon namespace interpretation remains the native compiler's job.

Limits default to 128 loaded documents, depth 32, 8,000,000 aggregate UTF-8 bytes, 512 resource directives and 64 queued native operations; callers may lower these budgets. Core per-document limits still apply. Resource maps and catalogues are snapshotted at compilation. Applications own their resolver I/O and must apply transport deadlines themselves: the native worker deadline does not interrupt application resolver promises or input iterators.

Native operations run sequentially. `timeoutMs` starts when an operation reaches the worker. Deadline expiry or an in-flight abort terminates the worker, rejects outstanding work and permanently invalidates the grammar. An already-aborted queued request is rejected without destroying a healthy worker. The structural signal is polled during native work. Host-side source normalization/preflight remains buffered and subject to source/core limits; this API does not claim incremental validation. Disposing is idempotent and terminates the entire private WASM realm.

In browsers, supply both `workerURL` (the packaged `dist/schema-worker.js` asset) and `engineURL` (a browser-loadable libxml2-wasm entry URL). Module workers do not inherit a page's import map. Serve worker, engine and WASM assets with appropriate MIME types, CORS and Content Security Policy permissions. A Node worker resolves the optional peer normally and needs no explicit URLs. Each browser worker creates a fresh engine instance; engine loading must remain possible under your deployment CSP.

Native successful-operation warnings are unavailable in the current upstream wrapper and are explicitly reported as unsupported. Diagnostics preserve original instance line/system identifier when exposed by the engine; absent columns are not invented. This companion supplies graph composition, worker isolation and hard native deadlines; it does not supply streaming schema validation, schema augmentation or type information.

## Opt-in instance hints

`compileIsolatedSchemaFromHints(instance, options)` reads root `xsi:schemaLocation` namespace/location pairs and `xsi:noNamespaceSchemaLocation`, resolves each through the explicit map or resolver (`kind: 'hint'`), then compiles a native grammar graph. Relative hints use the instance source identifier and root `xml:base`. Missing hints, duplicate namespaces, malformed pairs, a missing root namespace entry, mismatched schema target namespaces and unknown resources are rejected. Nested hints are deliberately rejected by this bounded root-hint mode. Hint discovery never fetches.

The returned grammar accepts the original instance with its unchanged approved hints, or subsequent instances without hints. Subsequent hinted instances must refer to the same compiled namespace/URI catalogue; changing a hint is a policy error. This prevents hint-based switching of an existing compiled grammar and preserves the original input for engine diagnostics. Explicit `compileIsolatedSchema` continues to reject all instance hints.

For per-document schema selection across changing or descendant hints, use [dynamic approved hints](schema-hints.md). This helper intentionally compiles one fixed root-hint snapshot.

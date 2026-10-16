# XSD validation

`xmlweave/schema` now uses the packaged Xerces-C++ WebAssembly provider by default. It requires no Java installation and no libxml2 peer installation. The engine was changed because the previous libxml2 provider accepted an invalid `xs:base64Binary` lexical value; the default now runs the same native validation engine as `xmlweave/schema-xerces`. There is no selective datatype approximation or silent fallback.

```js
import { compileSchema } from 'xmlweave/schema';
const schema = await compileSchema(`
  <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:element name="count" type="xs:positiveInteger"/>
  </xs:schema>`);
try {
  const result = await schema.validate('<count>3</count>');
  console.log(result.valid, result.diagnostics);
} finally { schema.dispose(); }
```

CommonJS can require the same companion and await its functions. `loadSchemaEngine()` optionally verifies/initializes the packaged default engine and releases its temporary native instance. Each compiled grammar owns a native engine instance. Initialization and validation are asynchronous, but the default still executes native CPU work in the calling JavaScript realm; promises do not imply worker isolation. Use the explicit isolated provider to enforce execution deadlines off the main thread.

## Compatibility and resource policy

The convenience `compileSchema` contract retains one explicit self-contained XSD 1.0 grammar. Preflight rejects DTDs, XInclude, schema composition directives, XSD 1.1 constructs, and instance schema-location hints before the engine runs. Use the explicit composition/provider APIs when requiring controlled include/import/schema-set behavior. There is no implicit file/network access. Original decoded text is passed unchanged, explicitly interpreted as UTF-8 after source decoding.

A schema-invalid but well-formed input returns `{valid:false,diagnostics}`. Malformed input, invalid schemas, denied resources, invalid options, cancellation and disposed handles reject with `SchemaError`. Native diagnostic wording, available columns and paths can differ from the previous engine; no libxml-specific error messages or XPath metadata are guaranteed. Existing source/session APIs, post-operation observers and error categories remain. The companion's basic API does not expose native streaming output, augmentation or type metadata: use the explicitly selected advanced provider and pipeline APIs for those capabilities.

Sessions are logically independent and non-reentrant. At most 32 active or queued validation episodes are permitted per grammar; excess concurrent requests reject with `RESOURCE_LIMIT`. Operations on separate sessions sharing one grammar are serialized through its native handle; callers may await them concurrently without invoking the native instance reentrantly. Disposing a grammar while sessions are active rejects with `BUSY`; disposing an idle grammar releases native grammar resources and invalidates its sessions. Repeated disposal is harmless. WASM linear-memory reservations need not shrink immediately after native disposal; public ownership checks do not prove allocator-level leak freedom.

The default conformance regression suite covers 43 original feature groups, including the previously failing base64 example, plus source and session behavior. It is measured coverage, not universal XSD certification. The 100-cycle lifecycle suite checks failed/successful compilation, validation, cancellation and disposed-handle behavior. Memory deltas are observations only; the previous engine's allocation tracker cannot measure this provider.

## Browser assets

Serve the packaged `xerces-engine.js` glue and `xerces-engine.wasm` assets with their relative module paths intact. The WASM response should use `application/wasm`. `compileSchema(source,{wasmUrl})` and `loadSchemaEngine({wasmUrl})` accept an explicit asset URL when deployment paths differ. The loader remains dynamic, and the core entry does not initialize the engine. Preserve runtime glue as an external module when bundling unless the chosen bundler explicitly preserves its asset URL behavior. A Content Security Policy must permit the chosen WASM loading/compilation strategy; advanced isolated providers additionally need worker-compatible asset/CSP setup. See the [native provider guide](schema-xerces.md), [isolated provider guide](schema-xerces-isolated.md), and [pinned rebuild instructions](../native/README.md) for assets, packaging and attribution. The default's packed browser paths are tested separately from the engine's source-tree probes.

## Portable sources and diagnostic provenance

`compileSchema` and `validate` retain their string signatures and also accept explicit source objects:

```js
const grammar = await compileSchema({ kind: 'text', text: xsd, systemId: 'https://app.example/schema.xsd' });
const validator = grammar.createValidator({ maxDiagnostics: 20 });
try {
  const result = await validator.validate({ kind: 'bytes', bytes: new TextEncoder().encode(xml), systemId: 'urn:invoice' });
  console.log(result.valid, result.diagnostics);
  validator.reset();
} finally {
  validator.dispose();
  grammar.dispose();
}
```

Sources are `string`, `{kind:'text',text,systemId?}`, `{kind:'bytes',bytes,encoding?,systemId?}`, `{kind:'dom',node,systemId?}`, and `{kind:'chunks',chunks,encoding?,systemId?}`. A system identifier is metadata, never permission to fetch. `normalizeSchemaSource` exposes the buffered adapter for providers. Chunks may be sync or async iterables containing exclusively strings or exclusively byte arrays. Byte chunks are copied, joined and decoded together, so split multibyte characters work. Mixing text and bytes is rejected. Abrupt termination while consuming closes the iterator; the structural signal is checked between chunks. It cannot interrupt an iterator whose next promise never settles.

Byte decoding recognizes UTF-8, UTF-16 and UTF-32 BOMs/signatures, checks encoding declaration conflicts, and uses fatal decoding. UTF-32 validates byte alignment and every Unicode scalar. ISO-8859-1 uses exact Latin-1 code points, including bytes 0x80–0x9F; US-ASCII rejects non-ASCII bytes. Additional declaration/explicit encodings depend on the runtime's `TextDecoder` labels; unsupported encodings fail instead of silently falling back to UTF-8. Other runtime-provided encodings use WHATWG decoder label mappings; this is not a promise of every XML processor encoding. The explicit portable encoding list is published in `schemaCapabilities.byteEncodings`. Decoded text is always passed to WASM explicitly as UTF-8, regardless of its original declaration.

A DOM document is serialized. An element becomes a standalone copied document; ancestor namespace declarations are copied even when needed only for QName values, and inherited resolvable `xml:base` is materialized. The input tree is never mutated. Unresolvable relative chains fail explicitly. DOM coordinates have `provenance:'generated'`; decoded text, bytes and joined chunks have `provenance:'original'`. Engine diagnostics preserve original lexical layout and carry `phase`, `systemId`, `sourceKind`, and `provenance`. Available engine/core line and column values are preserved; absent positions remain absent. Preflight does not reserialize text input.

## Session, observer and limit contracts

A compiled grammar creates independent sessions with `createValidator(options?)`. Session options are snapshotted; validation overrides apply to one call. `reset()` restores the creation configuration by clearing the episode (per-call overrides are never retained). Compilation processing limits (`maxCharacters`, `maxBytes`, `maxDiagnostics`) are immutable upper bounds inherited by convenience validation and new sessions; session/per-call overrides may lower but never increase those factory bounds. Compilation observers, signals and error policy are not inherited by sessions. The convenience grammar `validate` creates and disposes an ephemeral session. Each session is non-reentrant: simultaneous validation, callback-driven reset and disposal reject with `BUSY`. Independent sessions may be awaited concurrently; the facade explicitly serializes operations on their shared asynchronous native handle. Disposing an idle grammar invalidates its child sessions; disposing while validation is active rejects with `BUSY`.

Options accept `maxCharacters` (1–1,000,000), `maxBytes` (1–4,000,000, byte sources), `maxDiagnostics` (1–10,000, default 100), `signal`, `onDiagnostic`, and `errorPolicy`. Unknown options and invalid bounds reject with `INVALID_ARGUMENT`. Source budgets are checked while collecting chunks, before engine use. The byte limit applies to the original byte source; transcoding a permitted Latin-1/UTF-16/UTF-32 input to the native UTF-8 transport does not apply that original byte limit a second time. The native transport remains bounded by the global UTF-8 ceiling. Core node/depth ceilings still apply. Diagnostics beyond the configured count are omitted and validation sets `diagnosticsTruncated:true`. Collection bounds the public result, not the native engine's temporary diagnostic storage.

The default `errorPolicy:'result'` returns schema-invalid results; `'throw'` adapts those results into `SchemaError('INVALID_XML')`. Operational failures always throw. `onDiagnostic` is a post-operation observer called in engine diagnostic order after the native validation episode completes; it does not stop native validation immediately. Observer exceptions preserve their original identity and sessions become reusable after unwinding. The facade does not advertise complete successful-warning coverage; the native callback path exists, but no naturally warning-only successful XSD fixture has been observed under this secure source policy. `schemaCapabilities` explicitly marks those warning, immediate-handler, true incremental, augmentation, type-information and hard-cancellation capabilities false. Buffered iterable input is not incremental XSD validation.

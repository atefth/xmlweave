# Optional XSD validation

Install the exact optional engine `libxml2-wasm@0.7.2`, then import from `xmlweave/schema`. The core entry does not initialize WASM. This companion accepts self-contained XSD 1.0 schemas and string XML documents; it does not claim XSD 1.1 support.

```js
import { compileSchema } from 'xmlweave/schema';

const schema = await compileSchema(`
  <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:element name="count" type="xs:positiveInteger"/>
  </xs:schema>`);
try {
  const result = await schema.validate('<count>3</count>');
  console.log(result.valid, result.diagnostics);
} finally {
  schema.dispose();
}
```

CommonJS can `require('xmlweave/schema')` and await the same functions. `loadSchemaEngine()` optionally initializes the engine before compilation. Compilation and validation return promises; WASM initialization is asynchronous, while each engine compile/validation phase runs synchronously on its calling thread. A promise does not move CPU work off-thread. Use an application-owned worker for untrusted or expensive schemas and terminate the worker to enforce a hard time budget.

Each compiled schema owns one engine validator. The compile source document is disposed immediately, and every validation document is disposed in `finally` after success or failure. Call `dispose()` in `finally` when finished; repeated disposal is harmless. Validation after disposal rejects with `SchemaError` code `DISPOSED`. The shared WASM runtime remains initialized for the life of the JavaScript realm; disposing a schema does not unload its module or shrink its linear-memory allocation.

Schema-invalid, well-formed XML returns `{ valid: false, diagnostics }`. Diagnostics contain a message and severity, plus line, column, and XPath when the engine supplies them. Compilation failure, malformed XML, forbidden resources, initialization failure, and use after disposal reject with `SchemaError`, whose `code`, `diagnostics`, and `cause` distinguish those failures. Source coordinates refer to the XML serialization passed to the engine, which may differ from the caller's original formatting. `INVALID_XML` and `INVALID_SCHEMA` preserve a core parser failure in `cause`.

Both async entry points and `validate` accept `{ signal: { aborted: boolean } }`, structurally compatible with an AbortSignal without requiring browser globals in declarations. Already-aborted requests reject with `ABORTED`; aborts during engine initialization are checked again after initialization. Synchronous WASM compilation and validation cannot be interrupted. A signal aborted during those phases cannot run its event callback until control returns. No network schema-loading API or custom resolver is exposed.

## Resource policy

The companion first parses input with the core's namespace-aware XML parser and resource limits, then serializes it before handing it to WASM. It rejects DTDs and undeclared entities, namespace-aliased XSD `include`, `import`, `redefine`, and `override` elements, all XInclude elements, and instance `xsi:schemaLocation` / `xsi:noNamespaceSchemaLocation` hints. These checks inspect parsed elements and expanded namespace URIs; comments, CDATA, and encoded namespace attributes cannot disguise composition directives. Imports without a schema location are also rejected. Supply a single self-contained schema with all required declarations. There is no file/network fallback or automatic import resolution. Engine document parsing additionally enables `XML_PARSE_NO_XXE` and `XML_PARSE_NONET`.

The underlying engine exposes global resolver APIs to other consumers. XMLWeave does not mutate those globals. Tests install a rejecting observer provider and verify forbidden documents never consult it. Core limits bound input length, tree nodes, and nesting; they do not bound the computational complexity of schema compilation or validation. No arbitrary-schema execution deadline or hard WASM-memory quota is promised.

## Browser and bundler findings

Actual Chromium, Firefox, and WebKit runs loaded the engine's native ESM modules and embedded WASM, compiled a schema, validated both valid and invalid documents, produced diagnostics, and disposed the validator. An esbuild browser ESM bundle works when `libxml2-wasm` remains external. Serve the installed engine's `lib` directory as native JavaScript modules and map its package name with an import map, for example:

```html
<script type="importmap">
{"imports":{"libxml2-wasm":"/vendor/libxml2-wasm/lib/index.mjs"}}
</script>
```

The relative module files must remain available at the corresponding URLs. The WASM payload is embedded in `lib/libxml2raw.mjs`, so this version needs no separate `.wasm` asset URL. A browser Content Security Policy must permit WebAssembly compilation and loading those JavaScript modules. This is evidence for tested modern engines, not every browser/bundler configuration.

Bundling the engine itself into one esbuild ESM file generated a file successfully but its asynchronous initialization did not settle within 15 seconds. Therefore that configuration is unsupported; preserve the peer as native ESM rather than bundling its circular asynchronous module graph. The companion's engine import stays dynamic so Node CommonJS can load the ESM-only engine asynchronously.

## Selection and lifecycle evidence

Selected `libxml2-wasm` 0.7.2 after public API checks of `XmlDocument.fromString`, `XsdValidator.fromDoc`, `validate`, `dispose`, structured error details, and the public `diag` allocation tracker. The npm package was 471,814 bytes compressed / 1,228,585 bytes unpacked at evaluation; most runtime size is its embedded WASM. Both wrapper `LICENSE` and bundled `LICENSE.libxml2` use MIT-style permission terms and require preserving notices. Preserve the upstream libxml2 contributor and file-specific notices when redistributing the engine; XMLWeave does not inline the peer dependency into its own package.

The test suite performs 100 cycles containing failed compilation, successful compilation, valid/invalid validation, aborted validation, and repeated disposal. The public engine tracker reports zero outstanding tracked objects at the end, without relying on garbage collection. One Windows Node 22 sample measured RSS +15,187,968 bytes, external memory -472 bytes, and ArrayBuffer memory -512 bytes during those cycles. RSS includes JIT, allocator, and runtime effects; this is a lifecycle observation, not proof of zero raw WASM leaks or constant total process memory. Tracker assertions cover deterministic wrapper ownership, and compile/validation failure paths are exercised separately.

Sources: [upstream repository and environment requirements](https://github.com/jameslan/libxml2-wasm), [XSD validator API](https://jameslan.github.io/libxml2-wasm/dev/classes/libxml2-wasm.XsdValidator.html), [published package](https://www.npmjs.com/package/libxml2-wasm/v/0.7.2). License inventory was checked directly in the exact installed package's `LICENSE` and `LICENSE.libxml2` files.

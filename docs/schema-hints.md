# Dynamic, approved schema hints

`xmlweave/schema-hints` implements document-driven schema selection: create one reusable validator without selecting a grammar up front, then each document's approved XSD hints select its own compiled schema set. The default compiler is the isolated native Xerces provider, not Java or the legacy libxml2 helper.

```js
import { createHintValidator } from 'xmlweave/schema-hints';
const validator = await createHintValidator({
  resourceMap: {
    'https://app.example/order.xsd': orderSchema,
    'https://app.example/customer.xsd': customerSchema
  },
  maxCachedSchemas: 4,
  timeoutMs: 10000
});
try {
  const result = await validator.validate({
    kind: 'text', systemId: 'https://app.example/document.xml', text: xml
  });
} finally { validator.dispose(); }
```

## Hint and resource policy

The adapter scans the whole bounded document, including descendant `xsi:schemaLocation` and `xsi:noNamespaceSchemaLocation` attributes. Relative locations resolve against the inherited `xml:base` chain and document system identifier. A hint for the document element's namespace is required somewhere in the document. Namespace/location pairs must be complete; no-namespace locations contain one URI. Repeated equivalent namespace/URI hints are deduplicated; conflicting locations for one namespace reject with `INVALID_XML`. DTDs, XInclude and malformed XML are rejected before compilation.

Only explicitly supplied resources or the explicit asynchronous resolver can approve a hinted URI. There is no implicit network/filesystem lookup. A resolver receives a frozen request containing `kind:'hint'`, namespace, lexical location, canonical requested URI and base URI; dependency requests additionally use include/import/redefine kinds. Undefined resolution rejects with `EXTERNAL_RESOURCE_FORBIDDEN`. Each selected schema's target namespace must match the hint. Cached native grammars are authoritative: the engine does not independently load instance hints during validation. Thus descendant base handling is determined once by the approved adapter, and the original instance text remains unchanged.

Catalogue resources are normalized and snapshotted before factory creation completes. Later changes to the original resource map, byte arrays or DOM trees cannot change selection. The canonical approved request URI is the resource identity and base; response source metadata does not redirect that identity. Resolver responses are pinned on first successful approval for this validator's lifetime, including dependencies. Recreate the validator when intentionally changing content behind a resource URI. Source and graph limits apply; the pinned resource catalogue defaults to 128 documents and eight million UTF-8 bytes.

This mode buffers each document to discover descendant hints before validating. It is not an incremental hint-discovery handler. Use an explicitly compiled native schema and the streaming pipeline when selecting the grammar before input consumption. `readDynamicSchemaHints` exposes the namespace-aware discovery step without resolving resources.

## Cache, concurrency and lifecycle

Cache keys contain the sorted canonical namespace/resource identity pairs. Resource identities refer to pinned content, so changing instance text without changing approved hints reuses the same grammar. The least-recently-used cache defaults to four grammars and permits a configured maximum of sixteen. Eviction disposes idle compiled handles. Active or queued handles are never evicted to make room: if every cache entry is in use, another schema set rejects with `RESOURCE_LIMIT`.

Validation episodes sharing a cached handle are serialized to avoid native reentrancy. Different entries may run independently. At most 32 pending operations are admitted by default, configurable from one to 128. Source/resolver waits, compilation and validation share an operation deadline; timeouts or disposal settle the public operation promptly and request native/iterator cleanup. An injected compiler must cooperate with cancellation; an uncooperative pending promise retains a bounded admission slot until it settles. `clearCache()` disposes idle grammars and rejects with `BUSY` if an episode is active. `dispose()` invalidates the facade, disposes cached handles and disposes late compilation results. Repeated disposal is harmless.

Creation-time processing limits are immutable ceilings; per-operation options may lower them. Creation callbacks apply to compilation; validation observers/handlers must be passed to `validate`, and are not inherited. Diagnostics preserve the original instance's source kind/provenance because approved hints are not removed or rewritten. Original byte budgets apply before transcoding; internal UTF-8 transport uses its separate bounded ceiling.

Optional `compiler(sources, options)` injection supports other explicitly selected providers implementing `validate` and `dispose`. The injected provider must enforce supplied security/timeout policy, use approved resources only, and treat its precompiled schema catalogue as authoritative over instance hints. No provider is discovered implicitly. Browser use follows isolated native worker/WASM asset requirements; exact asynchronous diagnostic handlers additionally require the documented SharedArrayBuffer/isolation capability. Ordinary result validation and observers do not imply that requirement.

## Relationship to the fixed helper

The older `compileIsolatedSchemaFromHints(sample, options)` selects one fixed schema set from a sample document and intentionally rejects changed hints. It remains a distinct convenience. `createHintValidator` is the per-document dynamic contract; it can validate successive documents selecting different approved schema sets and incorporates approved descendant namespace hints.

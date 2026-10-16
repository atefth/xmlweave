# Whole-repository Ponytail audit

What this repo does: XMLWeave parses and edits XML, runs read-only XPath queries, streams large documents, transforms XML, and validates XSD schemas through native browser/Node workers and an optional Java provider. I assumed the documented limits: one million input characters, 256 element levels and 100,000 DOM nodes for ordinary parsing, plus separately bounded streaming and schema operations. Applications may reuse handles concurrently, supply asynchronous producers, and run in Node or supported browsers.

**Must fix**

1. **Oversized schema batches are read before rejection** (`src/schema-xerces.ts:L331-340`, `src/schema-java.ts:L293-302`)
   - **What this is:** Both direct providers accept an array of schema sources, including asynchronous chunk producers. They allow at most 256 sources.
   - **Problem:** They normalize every source before checking the array length. A probe with 257 producers reads all 257 before returning `RESOURCE_LIMIT`; a producer that never finishes can delay a call that should fail immediately, and large byte sources allocate decoded text unnecessarily.
   - **Fix:** Check the original array length before normalization. Add one regression per provider asserting that a rejected 257-source batch reads no producers.
   - **If we skip it:** The document-count admission limit does not protect the caller from work and memory consumed by oversized requests. This also gives producers observable side effects for a request that can never succeed.

Verdict: Fix source-count admission in both direct providers before merging; no additional actionable defect was reproduced in the audited baseline paths.

Not checked: This is not an independent line-by-line audit of the upstream XPath, XSLT, libxml2, Xerces, Java, or browser engines. I did not run fuzzing, heap-exhaustion attacks, every W3C test, or long-duration multi-process load tests. Engine CPU limits explicitly documented as cooperative or absent were not treated as undocumented guarantees.

## Evidence and scope

- Read the public core, XPath, streaming and transform implementations and their documentation; traced schema source normalization, graph loading, worker transport, deadlines, diagnostic callbacks, provider factories, hint validation, and event pipelines using the earlier independent reviews and acceptance probes.
- Reviewed package inclusion, build/consumer paths and CI coverage. No new network/filesystem policy bypass was reproduced in XPath or transforms. The documented trusted-query/trusted-stylesheet limitations remain relevant.
- Core/XPath/stream/transform focused baseline: 32/32 tests passed, including the 100,000-record stream case.
- Latest prior packaged-browser acceptance evidence: 115 assertions in each of Chromium, Firefox and WebKit, including actual worker assets, incremental validation, hard cancellation, asynchronous diagnostic gating, runtime factories, dynamic schema hints, anonymous type identities and the pinned original W3C/NIST corpus. No unexpected resource requests were recorded.
- Latest focused isolated/reliability/hints acceptance run: 52/52 tests passed. These acceptance results supplement the audit; they do not establish full XSD certification.
- Reproduction for finding 1: `node .artifacts/ponytail-provider-admission.mjs`. Observed native `{code:"RESOURCE_LIMIT",reads:257}` and Java `{code:"RESOURCE_LIMIT",reads:257}`. No Java process or native grammar needs to start to reproduce the defect.

## Findings corrected during the audit

These are recorded for traceability, not counted as outstanding findings.

- The schema catalogue previously cloned all unused byte resources before applying graph budgets. A 32-entry map sharing a single 256 KiB array allocated another 8,388,608 array-buffer bytes despite `maxGraphBytes:1024`. Current `src/schema-graph.ts` checks root/catalogue counts and fixed source sizes before snapshots; the parent added the fix while the audit was running.
- The package previously included identical native runtime JavaScript/WASM assets in both `native/runtime` and `dist`, adding 4,029,849 duplicate unpacked bytes. Current package inclusion selects native rebuild sources/documentation and ships runtime assets only through `dist`.

No requested Java parity feature was classified as unnecessary merely because it is optional. No source code was edited for this audit.


## Resolution record

The findings above describe the reviewed snapshot. Corrections were applied after
review; their regression evidence is recorded below before this change is merged.

- Schema catalogue admission checks precede snapshot copies; tests observe zero
  copies for rejected input and immutability for accepted input.
  Tracked in [the catalogue-budget issue](https://github.com/atefth/xmlweave/issues/75).
- Direct native and Java compilers reject source counts above 256 before consuming
  a producer. The regression asserts zero reads for an oversized batch.
- Packed artifacts retain one runtime, bridge source, rebuild instructions and
  attribution. A consumer assertion checks exactly one native WASM asset.
  Tracked in [the package-size issue](https://github.com/atefth/xmlweave/issues/76).
- Regression cases are retained in `test/schema-graph-budget.test.mjs`,
  `test/validation-reliability.test.mjs` and `scripts/consumers.mjs`.
  Final test and packed-artifact outcomes are recorded in the PR.


## Final verification of corrected paths

The final coherent build passes 236 Node tests, 345 packaged validation-browser
assertions across Chromium/Firefox/WebKit, packed consumers on TypeScript 5.9.3
and 7.0.2, and all 123 Java reference expectations. The affected admission,
normalization, cancellation, accounting and packaging paths were checked again
after the fixes; no confirmed must-fix finding remains.

**Final verdict: Ship**, subject to required PR CI and merge. The snapshot findings
above remain as an audit trail. Universal XSD conformance, arbitrary custom Java
providers, prolonged-load fuzzing and upstream engine internals were not audited.

Direct-provider admission is tracked in [the batch-admission issue](https://github.com/atefth/xmlweave/issues/77).

CI follow-up: native source/runtime line endings are pinned in `.gitattributes`.
A real rebuild from canonical LF source produced identical runtime assets and
updated the source hash; the build provenance gate passes. Rechecked this
packaging-only correction; no new behavioral finding.

CI worker correction: the self-contained native worker now starts with no parent
CLI flags. A real child-process regression covers incompatible Node runtime flags;
35 affected isolation/hint tests pass. Independent affected-path Ponytail review
and the host transport audit found no remaining issue.

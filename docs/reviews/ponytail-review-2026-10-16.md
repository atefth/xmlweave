# Ponytail review — final focused pass

What this change does: XMLWeave gains a packaged Xerces validator, an optional Java provider, isolated workers, schema catalogues, typed validation events and matching input/output adapters. It also adds limits, cancellation, diagnostic handlers and a documented Java API mapping.

Review mode: **Ponytail full**, applying [Ponytail rules](https://github.com/DietrichGebert/ponytail/blob/6f1c2bfff0c837d268929a7c4e490918eb4fab29/skills/ponytail/SKILL.md) and [Ponytail review](https://github.com/DietrichGebert/ponytail/blob/6f1c2bfff0c837d268929a7c4e490918eb4fab29/skills/ponytail-review/SKILL.md). This is a read-only review of the current uncommitted implementation, informed by the earlier requirements and acceptance audits. It does not reduce the explicitly requested Java validation scope.

Assumed load: a reusable library used in Node or browsers, with untrusted bounded XML, concurrent independent sessions, repeated documents and cooperative asynchronous input. The documented limits, isolated deadlines and bounded caches are part of the contract.

## Must fix

1. **The pipeline counts decoded bytes twice** (`src/schema-pipeline.ts:1085`, `src/schema-pipeline.ts:1115`).
   - **What this is:** The stream-family adapter decodes the supplied bytes, then sends the resulting text to the native stream validator.
   - **Problem:** It forwards the original `maxBytes` ceiling to the generated UTF-8 transport. With ISO-8859-1 bytes for `<root>é</root>` and `maxBytes` equal to the input byte length, `compiled.validate(...)` succeeds but `validateSource(..., 'none', ...)` rejects with `RESOURCE_LIMIT`. The original source is within its limit; the generated UTF-8 representation is one byte longer.
   - **Fix:** Keep the original-byte check in source normalization and use the existing normalized-input transport mechanism, or an equivalent explicitly prechecked path, for the native call. Preserve the original output-byte ceiling separately for a requested byte result; also respect an inherited provider ceiling rather than trying to raise it through an ordinary override.
   - **If we skip it:** Legal byte inputs fail only when callers use the public pipeline adapter. Add one regression comparing direct and pipeline validation of this bounded non-UTF-8 input.

2. **A stalled buffered source prevents pipeline cancellation** (`src/schema-pipeline.ts:1083`, `src/schema-pipeline.ts:1092`).
   - **What this is:** Stream-family chunk sources are normalized before the adapter starts native validation.
   - **Problem:** `normalizeSchemaSource` awaits the source's `next()` directly. If that promise does not settle, changing the supplied signal to aborted does not settle `validateSource`; the provider never receives control and cannot apply its own cancellation. A focused probe remained pending after abort, and settled only when the source was manually released. Complete pipeline option validation also currently happens after this input consumption.
   - **Fix:** Validate pipeline options before consuming input. Reuse `normalizeSourceWithDeadline`/the existing source cancellation machinery instead of adding another timer implementation, checking provider disposal while waiting and retaining source provenance. Keep the documented distinction between stopping the public operation and forcibly resuming an arbitrary producer.
   - **If we skip it:** An abandoned or failed source can leave an application request pending indefinitely even after cancellation. Add a stalled-iterator regression that aborts without releasing `next()` and verifies prompt rejection and one requested iterator closure.

3. **One rejected hint resource exhausts later catalogue space** (`src/schema-hints.ts:413`).
   - **What this is:** Dynamic hint validation pins approved schema text in a reusable, byte-limited catalogue.
   - **Problem:** `store()` increments `resourceBytes` before checking the limit, but leaves that increment in place when the resource is rejected. Reproduced with `maxGraphBytes: 200`: an oversized resolver result fails as expected; a subsequent 86-byte schema also fails, even though neither schema was stored and the compiler was never called.
   - **Fix:** Compute the proposed total, reject it if necessary, then assign `resourceBytes` only when accepting the resource. This requires no new abstraction.
   - **If we skip it:** A failed document permanently damages an otherwise healthy reusable hint validator. Add one regression that rejects an oversized resource and then successfully validates a different document using a small approved resource on the same validator.

## Checked

- Read both requested Ponytail skill files, the tracked diff and the current connected provider/factory, pipeline, source normalization, hint-cache, graph and worker code; checked the relevant tests and public documentation.
- Traced explicit factory settings into real Xerces/Java compilation, original/generated source provenance, isolated diagnostic request/acknowledgement handling, worker message bounds and termination, pipeline input/output matching, and the Java launcher/protocol boundary.
- Reproduced all three findings through the built public entry points, and confirmed the responsible logic remains in the current TypeScript source. The first two probes used a real compiled Xerces schema; the cache probe injected a minimal compiler to isolate catalogue state from native work.
- No confirmed security disclosure, unwanted network/file transport, or additional native derivation defect was found in this pass. No stylistic or speculative refactor findings are included. Reusing the existing source helper in finding 2 is the material simplification.

Verdict: fix 1, 2 and 3 first.

Not checked: I did not repeat the full browser/Java/package suites or final CI in this read-only pass; the parent is coordinating those against the final coherent build. This report does not certify every XSD input or arbitrary Java providers.


## Resolution record

The findings above describe the reviewed snapshot. Corrections were applied after
review; their regression evidence is recorded below before this change is merged.

- Byte budgets: a shared internal normalized-transport proof retains original byte
  counts while bounding UTF-8 transport separately. Provider inherited limits still
  apply. Public output byte limits remain separate. Tracked in [the byte-budget issue](https://github.com/atefth/xmlweave/issues/72).
- Cancellation: pipeline options are checked before source consumption and the
  existing source-deadline helper handles abort/disposal and iterator closure.
  Tracked in [the cancellation issue](https://github.com/atefth/xmlweave/issues/73).
- Catalogue state: proposed bytes are checked before committed accounting changes;
  a rejected oversized resource no longer poisons a later small resource.
  Tracked in [the accounting issue](https://github.com/atefth/xmlweave/issues/74).
- Regression cases are retained in `test/schema-pipeline.test.mjs` and
  `test/schema-hints.test.mjs`. Final test outcome is recorded in the PR.


## Final verification of corrected paths

The final coherent build passes 236 Node tests, 345 packaged validation-browser
assertions across Chromium/Firefox/WebKit, packed consumers on TypeScript 5.9.3
and 7.0.2, and all 123 Java reference expectations. The affected admission,
normalization, cancellation, accounting and packaging paths were checked again
after the fixes; no confirmed must-fix finding remains.

**Final verdict: Ship**, subject to required PR CI and merge. The snapshot findings
above remain as an audit trail. Universal XSD conformance, arbitrary custom Java
providers, prolonged-load fuzzing and upstream engine internals were not audited.

CI follow-up: native source/runtime line endings are pinned in `.gitattributes`.
A real rebuild from canonical LF source produced identical runtime assets and
updated the source hash; the build provenance gate passes. Rechecked this
packaging-only correction; no new behavioral finding.

CI worker correction: the self-contained native worker now starts with no parent
CLI flags. A real child-process regression covers incompatible Node runtime flags;
35 affected isolation/hint tests pass. Independent affected-path Ponytail review
and the host transport audit found no remaining issue.

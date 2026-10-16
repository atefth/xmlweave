# Pinned W3C/NIST datatype selection

These are unmodified excerpts from the W3C XML Schema test-suite repository, contributed by NIST. The original `00COPYRIGHT` is retained unchanged at `upstream/00COPYRIGHT`; that notice applies to this copied material. Its W3C document license is separate from XMLWeave's MIT license.

- Original repository: https://github.com/w3c/xsdtests
- Pinned revision: `7bc3365c652a322f3d762021b3879eb92dae7e30`
- Original metadata: https://github.com/w3c/xsdtests/blob/7bc3365c652a322f3d762021b3879eb92dae7e30/nistMeta/NISTXMLSchemaDatatypes.testSet
- Original copyright: https://github.com/w3c/xsdtests/blob/7bc3365c652a322f3d762021b3879eb92dae7e30/00COPYRIGHT
- Applicable notice/license linked by upstream: https://www.w3.org/Consortium/Legal/copyright-documents-19990405.html

`upstream/` contains exact fixture bytes read with `git show` at that revision, avoiding checkout newline conversion. `NISTXMLSchemaDatatypes.testSet.gz` contains the complete, unchanged original metadata bytes compressed losslessly. `manifest.json` records original paths, byte counts, SHA-256 hashes, Git blob identifiers, permanent source links, original expected validity and original accepted-status metadata. Nothing in these files is relicensed as MIT.

Selection was fixed before running an engine: the first group in upstream metadata order for each of eight named datatype families, plus the first group declaring invalid instances where one exists. Every schema and instance of each selected group is retained. There are 13 groups, 13 valid schemas and 65 instances: 40 valid and 25 invalid. The selected base64Binary, boolean and hexBinary groups contain only valid instances in upstream metadata; no synthetic negative case is represented as an upstream case.

The datatype families are base64Binary, date, integer, decimal, boolean, hexBinary, duration and string. This selection tests particular facets and lexical values from those groups, not all facets or all values of those datatypes. It is not the full W3C corpus, certification, a complete XSD 1.0 conformance claim, or a PSVI conformance suite.

The tracked integrity test decompresses and hashes the original full metadata, re-reads the selected group expectations from that authority, verifies every copied source, and checks that no selected instance or expectation was dropped or changed. Native tests pass the original byte sources and retain instance schema hints; source identifiers are canonical original upstream URLs, and the already compiled in-memory grammar catalogue resolves hints without fetching. The test runner neither edits instance hints nor rewrites fixture XML. All mismatches fail their named test; there is no expected-failure suppression or runtime filtering.

Reproduce from a local upstream Git checkout containing the pinned revision:

```text
python scripts/import-w3c-nist.py /path/to/xsdtests
```

The importer writes only this selected fixture directory and does not fetch or update the upstream checkout. Run `node --test test/xsd-w3c-nist.test.mjs` after the package build. `scripts/validation-browser.mjs` additionally runs all 65 original instances with the installed packed library and packaged worker assets in Chromium, Firefox and WebKit.

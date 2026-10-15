# Optional transformations

`xmlweave/transform` prepares an explicitly bounded XSLT 1.0 subset and executes it asynchronously against XML strings. Install the separately replaceable engine with `npm install xslt-processor@5.1.2`. This peer is optional: importing the XML core never loads it. The engine is dynamically imported when preparing a stylesheet, allowing both CommonJS and ESM consumers to use the same asynchronous API.

```js
import { compileStylesheet } from 'xmlweave/transform';
const stylesheet = await compileStylesheet(`
  <xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
    <xsl:param name="greeting"/>
    <xsl:template match="/">
      <message><xsl:value-of select="$greeting"/> <xsl:value-of select="/person/name"/></message>
    </xsl:template>
  </xsl:stylesheet>`);
try {
  const result = await stylesheet.transform('<person><name>Robin</name></person>', {
    parameters: { greeting: 'Hello' },
  });
} finally { stylesheet.dispose(); }
```

`transformXml(xml, stylesheet, options?)` is a one-shot convenience that always disposes its prepared stylesheet. `compileStylesheet` validates XML and the permitted instruction/expression policy, loads the engine and parses the stylesheet eagerly. It is preparation, not native compiled bytecode or full XSLT static analysis. Every transformation uses a fresh engine/parser instance so parameters and mutable execution state cannot bleed across calls. `dispose()` is idempotent and clears the retained stylesheet string; there are no explicit native resources. Reuse after disposal fails with `DISPOSED`.

## Evaluated engines and decision

Evaluated the current published packages and primary upstream descriptions on 2026-10-15:

| Candidate | Runtime/version tradeoff | License and decision |
| --- | --- | --- |
| xslt-processor 5.1.2 | Pure JavaScript; npm provides CJS/ESM/browser entries and async XSLT processing; replaceable loader hooks. Our real fixtures verify selected XSLT 1.0 operations. | LGPL-3.0. Selected as an external optional peer; XMLWeave does not bundle or modify it in its distributed artifact. |
| SaxonJS 2.7.0 | Advertises XSLT 3.0 and uses its own compiled stylesheet/deployment workflow. | Package declares `SEE LICENSE IN LICENSE.txt`; commercial/custom licensing and compiler workflow require separate assessment. Not selected and not distributed. No inference that it is MIT or freely relicensable. |
| node-libxslt 0.10.2 | Native Node addon around libxslt; requires a native toolchain and does not provide the browser path sought here. | Wrapper metadata says MIT; native dependency obligations and build matrix would need separate verification. Not installed or selected. |

Go criteria were actual scalar parameters, namespace-aware output, XML/text results, controlled resolution, both package modes and tested browser execution. The checked-in regression tests are the selection evidence. This does not establish full XSLT 1.0 conformance; XSLT 2.0/3.0 and engine-specific additional features remain unsupported even if the underlying package exposes them.

## Supported contract and controls

The stylesheet must have an XSLT-namespace `stylesheet` or `transform` root with `version="1.0"`. Supported instructions include templates, apply-templates, call-template, parameters, variables, for-each, sorting, conditionals, text/value-of, literal result elements, attributes/elements, copy/copy-of, keys, numbering, decimal formatting and whitespace rules. Only the tested operations are advertised as verified; untested edge cases remain engine limitations. The facade rejects instructions outside its allowlist, including logging messages. Query functions are restricted to the standard XPath 1.0/XSLT helper allowlist in source; prefixed extension calls and newer dynamic function syntax are rejected. Unique prefixes declared on nested elements are normalized to the stylesheet root because of an observed engine lookup limitation. Scoped prefix rebinding is explicitly rejected; use a different prefix for each URI. Unbound expression prefixes fail before execution. At most one top-level output declaration is permitted, avoiding the engine's ambiguous multiple-declaration behavior. This is a constrained transformation companion, not an arbitrary XSLT execution service.

`parameters` is a plain record of unprefixed names to strings, finite numbers or booleans; values are passed as data, without interpolating XPath source. `outputMethod` is determined by `xsl:output`, defaults to XML and can be XML or text. XML output must reparse as one complete document within core limits; fragments, DTD output, HTML, JSON, CDATA overrides and disabled output escaping are rejected. Text output preserves decoded text, without XML escaping.

Input and stylesheet pass through core XML parsing before the engine, which enforces well-formedness, namespaces, DTD/entity rejection and core length/depth/node limits. Namespace-aliased includes/imports, secondary result documents and extension elements are rejected. XPath document-loading calls are rejected during policy checks; the engine's `fetchFunction` and `documentLoader` also always throw, with no file/network fallback or caller resolver override. Tests install a failing fetch observer and verify no external calls occur, including malicious stylesheet cases and attribute value templates.

`TransformError` has stable codes (`INVALID_ARGUMENT`, `INVALID_STYLESHEET`, `INVALID_XML`, `UNSUPPORTED_FEATURE`, `EXTERNAL_RESOURCE_FORBIDDEN`, `ENGINE_UNAVAILABLE`, `TRANSFORM_FAILED`, `RESOURCE_LIMIT`, `DISPOSED`, `ABORTED`) and an optional original cause. `maxOutputLength` may lower 1,000,000 UTF-16 units and is checked after the engine returns. `signal.aborted` is checked before and after execution, but cannot interrupt a running synchronous engine phase. Recursive templates, expensive queries and intermediate result growth are not bounded by these checks. Use trusted stylesheets, and isolate work in a worker/process if hard time or memory limits are required. No safe execution claim for hostile compute workloads is made.

## Packaging and license boundary

XMLWeave's facade remains MIT. xslt-processor is LGPL-3.0 and remains a separate optional peer resolved by the application; it is neither copied into `dist/transform.cjs` nor hidden behind an MIT notice. Its unchanged installed package retains its original license. Applications that redistribute or bundle that engine must retain its notices and satisfy its LGPL terms, including source/relinking requirements as applicable to their distribution. The test browser bundle is a verification fixture, not a shipped XMLWeave runtime artifact. See upstream source and its full license rather than interpreting the XMLWeave MIT grant as covering the peer.

Sources: [xslt-processor source and API](https://github.com/DesignLiquido/xslt-processor), [its LGPL license](https://github.com/DesignLiquido/xslt-processor/blob/main/LICENSE), [SaxonJS package](https://www.npmjs.com/package/saxon-js/v/2.7.0), [node-libxslt source](https://github.com/albanm/node-libxslt). Exact package metadata and installed 5.1.2 engine declarations/loader hooks were inspected alongside executable tests.

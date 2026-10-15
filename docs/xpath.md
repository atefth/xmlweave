# Optional XPath companion

`xmlweave/xpath` adds read-only XPath queries over documents created by the core package. Importing `xmlweave` alone does not load the XPath engine. The companion bundles an isolated FontoXPath 3.34.0 runtime; it does not import the core runtime or construct another slimdom instance. Query node results are the original DOM nodes, so edits through them affect their document. Public declarations reference slimdom types without exposing FontoXPath's ambient DOM declarations.

```js
import { parseXml } from 'xmlweave';
import { evaluateXPathToNodes, evaluateXPathToNumber } from 'xmlweave/xpath';

const document = parseXml('<catalog xmlns="urn:books"><book price="12"/></catalog>');
const options = {
  namespaces: { b: 'urn:books' },
  variables: { minimum: 10 },
};
const books = evaluateXPathToNodes('/b:catalog/b:book[number(@price) >= $minimum]', document, options);
const count = evaluateXPathToNumber('count(/b:catalog/b:book)', document, options);
```

CommonJS uses `require('xmlweave/xpath')` with the same export names. Contexts may be documents, elements, attributes, text/CDATA, comments or processing instructions with an owner document. There is no implicit global document and no engine-specific constructor check. Pass a core-created DOM node; arbitrary duck-typed objects are not a security boundary.

## Results, namespace bindings and variables

`evaluateXPath(expression, context, options?)` defaults to `Node[]`. Set `returnType` to `nodes`, `firstNode`, `string`, `number` or `boolean`; TypeScript infers the corresponding result. The convenience exports `evaluateXPathToNodes`, `evaluateXPathToFirstNode`, `evaluateXPathToString`, `evaluateXPathToNumber` and `evaluateXPathToBoolean` select the same conversions. `firstNode` returns `null` for an empty sequence; a node result requested for an atomic expression fails. Conversions use the engine's XPath rules rather than JavaScript truthiness. There is no generic map/function-item JavaScript result conversion in this facade.

Namespaces are an explicit plain record, independent of XML prefix spelling. Unprefixed element tests select no-namespace elements unless `namespaces['']` supplies a default element namespace. Bind your own prefix to query namespaced attributes. Standard `fn`, `xs`, `math`, `map`, `array` and `xml` prefixes cannot be rebound. URI-qualified names (`Q{urn:books}book`) are supported.

Variables use unprefixed ASCII names and scalar string, finite number, boolean or `null` values. `null` represents an empty sequence; JavaScript numbers enter as XPath doubles. Node, function, object and sequence variables are deliberately unsupported. Namespace prefix names also use the documented ASCII subset. Records must be plain objects (or have a null prototype), and accessor properties are rejected. Supply external text through variables rather than query-string interpolation.

## Tested feature matrix and gaps

Original tests verify these features against core parsed, created and mutated DOMs:

| Feature | Evidence or boundary |
| --- | --- |
| Paths, predicates, attributes and document order | Node identity and attribute-selection fixtures |
| Explicit/default element namespaces and URI-qualified names | Namespaced source with independently bound query prefixes |
| Scalar variables and result conversions | Strings containing quote/operator syntax remain data; empty sequence and number/boolean fixtures |
| XPath 3.1 sequence expressions | `for`, arithmetic and `sum` |
| Maps and arrays inside queries | Map lookup and `array:size`; no map/function result API |
| Arrow expressions and inline functions | String joining and inline arithmetic function invocation |
| Standard math functions | `math:pi()` |
| Invalid syntax, unknown functions and missing variables | Errors retain their engine cause |
| XQuery and updating expressions | Rejected: only XPath 3.1 language is enabled |

This is a tested subset, not a complete XPath 3.1 conformance claim. There is no XPath 1.0 compatibility mode or compatibility promise. Schema-aware typing, custom functions/modules, external resources, query updates and arbitrary function-item results are outside the API. Unknown or unimplemented standard functions fail explicitly. The upstream project documents incomplete standards coverage; future engine updates must rerun this matrix and policy tests.

## Read-only policy, errors and resource boundaries

Queries are parsed into a detached XQueryX syntax tree using the context's document factory. The facade inspects that same tree before evaluation, including unreachable branches, named function references and named arrow-call targets. Policy checks both XQueryX function-name representations (functionName and arrow-target EQName), resolving prefix and URI-qualified forms consistently. Regression tests reject arrow-based dynamic-lookup and external-function bypasses before execution. It accepts functions only in standard function/type/math/map/array namespaces. It rejects external document/collection/text loading, environment-variable access, tracing, XML-string parsing, transformation/module loading and dynamic `function-lookup`. Extension namespaces, including FontoXPath's dynamic evaluator, are rejected. XQuery/update APIs, function registration, resolver callbacks and module imports are never exposed. The engine runtime is bundled privately to keep independent consumer registrations from injecting callbacks into it.

`XPathError` has `code` and an optional `cause`: `INVALID_ARGUMENT`, `RESOURCE_LIMIT`, `UNSUPPORTED_FEATURE` or `EVALUATION_FAILED`. Syntax, type, unsupported standard-function and evaluation errors use `EVALUATION_FAILED`; denied policy functions use `UNSUPPORTED_FEATURE`. Original engine messages are diagnostic causes, not stable API codes. There is no document mutation or network/file resolver performed by this facade.

`maxQueryLength` may lower the default cap of 10,000 UTF-16 code units. The parsed syntax tree is capped at 50,000 nodes, and compilation caching is disabled so repeated untrusted queries do not accumulate compiled queries. These caps are not a CPU timeout, result-size limit or memory sandbox. Short expressions can still create large sequences or perform expensive recursion. Use a terminable worker/process with application-level resource controls for untrusted queries. Returned nodes remain mutable and application callback behavior is outside query policy.

## Engine, licensing and measured cost

FontoXPath 3.34.0 is selected for this optional companion after interoperability and policy tests. Its MIT license, plus the bundled MIT notices for prsc and xspattern, must accompany distribution. The optional entry bundles its engine; the core runtime dependency set remains unchanged. A consumer importing only the core entry does not load this extra runtime.

An illustrative local measurement on Node 22.17.1 / Windows with esbuild 0.28.2 (`bundle`, browser platform, ESM, ES2022, minify; gzip via Node zlib) gave 67,983 bytes / 20,520 gzip for the core source entry and 328,542 bytes / 95,380 gzip for the XPath source entry alone. These are separate source-bundle measurements, not installed tarball sizes; wrapper/notice changes can alter final output. `sum(/r/item)` over 100 items returned 4,950: first query 6.12 ms; 1,000 further evaluations with syntax inspection and cache disabled took 222.70 ms total. These measurements are evidence of optional cost, not speed guarantees or a benchmark comparison against other engines.

## Primary sources

- [FontoXPath documentation and API](https://github.com/FontoXML/fontoxpath): query language, DOM facade and result configuration.
- [FontoXPath MIT license](https://github.com/FontoXML/fontoxpath/blob/master/LICENSE.md).
- [Upstream contribution notes](https://github.com/FontoXML/fontoxpath/blob/master/CONTRIBUTING.md): standards coverage and test practices.
- [XPath 3.1 specification](https://www.w3.org/TR/xpath-31/).

Installed package metadata and the lockfile identify the exact evaluated versions; upstream links describe evolving source. The facade's tests and restrictions define its supported contract.


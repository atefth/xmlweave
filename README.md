# XMLWeave

Planned TypeScript-first XML toolkit for JavaScript and TypeScript, inspired by Java `javax.xml`.

**Status: planning; no library implementation or release exists yet.**

The first release targets synchronous whole-document XML string parsing, document creation and mutation, well-formed serialization, consistent errors and semantic roundtrips. ESM `import`, CommonJS `require` and TypeScript declarations will be validated with packed-artifact consumer fixtures. Supported runtime and toolchain versions will be established by tests.

No XML engine has been selected. slimdom is a conditional candidate pending namespace, malformed XML, entity and DTD-policy evaluation. Core public types should not require browser globals or `@types/node`.

XPath, streaming, asynchronous schema validation and transformations are optional future companions. XML signatures, SOAP and object mapping are future scope decisions, not v1 commitments.

Follow the [XMLWeave Roadmap](https://github.com/users/atefth/projects/3) and [backlog issues](https://github.com/atefth/xmlweave/issues). Only actionable foundation investigations are Ready; other work is Backlog.

The project license has not yet been selected. Candidate dependency licenses will be reviewed before distribution.

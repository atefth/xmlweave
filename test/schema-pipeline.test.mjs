import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeValidationEvents,
  validateEventStream,
  createValidationHandler,
  validateSource,
} from "../dist/schema-pipeline.js";
import {
  createSchemaFactory,
  createSchemaProviderRegistry,
} from "../dist/schema-factory.js";
import { compileJavaSchema } from "../dist/schema-java.js";
import { parseXml, serializeXml } from "../dist/index.js";
const name = (name, namespaceURI = "") => ({
  name,
  localName: name.split(":").at(-1),
  namespaceURI,
});
function events(text = "4") {
  return [
    { kind: "startDocument" },
    { kind: "startElement", ...name("r"), attributes: [] },
    { kind: "text", text },
    { kind: "endElement", ...name("r") },
    { kind: "endDocument" },
  ];
}
async function collect(source) {
  const list = [];
  for await (const v of source) list.push(v);
  return list;
}
const xsd =
  '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r"><s:complexType><s:simpleContent><s:extension base="s:int"><s:attribute name="mode" default="normal"/></s:extension></s:simpleContent></s:complexType></s:element></s:schema>';
async function java(t, schema = xsd) {
  try {
    return await compileJavaSchema(schema, { timeoutMs: 15000 });
  } catch (e) {
    if (e.code === "ENGINE_UNAVAILABLE" && !process.env.XMLWEAVE_REQUIRE_JAVA) {
      t.skip("Optional Java JDK is unavailable.");
      return;
    }
    throw e;
  }
}
test("namespace protocol handles QName context, balanced lifecycles, escaping and locators", async () => {
  const source = [
    { kind: "startDocument" },
    { kind: "startPrefixMapping", prefix: "p", namespaceURI: "urn:p" },
    {
      kind: "startElement",
      ...name("p:r", "urn:p"),
      attributes: [{ ...name("a"), value: "p:T\n" }],
      locator: { systemId: "urn:input", line: 12, column: 7 },
    },
    { kind: "text", text: "]]>" },
    { kind: "endElement", ...name("p:r", "urn:p") },
    { kind: "endPrefixMapping", prefix: "p" },
    { kind: "endDocument" },
  ];
  const mapped = [];
  const text = (
    await collect(
      serializeValidationEvents(source, { onLocator: (m) => mapped.push(m) }),
    )
  ).join("");
  assert.equal(parseXml(text).documentElement.textContent, "]]>");
  assert.equal(parseXml(text).documentElement.getAttribute("a"), "p:T\n");
  assert.equal(mapped[0].locator.line, 12);
  assert.equal(Object.isFrozen(mapped[0]), true);
  for (const bad of [
    events().slice(0, -1),
    [...events(), { kind: "text", text: "suffix" }],
    [
      { kind: "startDocument" },
      { kind: "startElement", ...name("p:r", "urn:p"), attributes: [] },
    ],
    [
      { kind: "startDocument" },
      { kind: "startPrefixMapping", prefix: "xml", namespaceURI: "evil" },
    ],
    [
      { kind: "startDocument" },
      {
        kind: "startElement",
        ...name("r"),
        attributes: [
          { ...name("a"), value: "1" },
          { ...name("a"), value: "2" },
        ],
      },
    ],
  ])
    await assert.rejects(collect(serializeValidationEvents(bad)), {
      code: "INVALID_ARGUMENT",
    });
});
test("explicit factory snapshots capabilities/configuration and rejects unknown or unsupported settings", async () => {
  const capabilities = { streaming: true, formats: ["XSD1.0"] };
  let observed;
  const provider = {
    id: "test",
    version: "1",
    capabilities,
    features: { secure: [true] },
    properties: { limit: { defaultValue: 8, minimum: 1, maximum: 10 } },
    async compile(source, options, configuration) {
      observed = configuration;
      return { source };
    },
  };
  const factory = createSchemaFactory(provider, {
    features: { secure: true },
    properties: { limit: 4 },
  });
  capabilities.formats.push("fiction");
  capabilities.streaming = false;
  assert.deepEqual(factory.provider.capabilities.formats, ["XSD1.0"]);
  assert.equal(factory.provider.capabilities.streaming, true);
  await factory.compile("x");
  assert.equal(observed.properties.limit, 4);
  assert.ok(Object.isFrozen(observed.features));
  assert.throws(
    () => createSchemaFactory(provider, { features: { secure: false } }),
    { code: "UNSUPPORTED_CAPABILITY" },
  );
  assert.throws(
    () => createSchemaFactory(provider, { features: { madeup: true } }),
    { code: "UNSUPPORTED_CAPABILITY" },
  );
  assert.throws(
    () => createSchemaFactory(provider, { properties: { limit: 11 } }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.throws(
    () => createSchemaFactory(provider, { properties: { unknown: 1 } }),
    { code: "UNSUPPORTED_CAPABILITY" },
  );
  assert.throws(() => createSchemaProviderRegistry([provider, provider]), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(
    () => createSchemaProviderRegistry([provider]).select("automatic-java"),
    { code: "UNSUPPORTED_CAPABILITY" },
  );
});
test("real Java event adapters preserve native defaults and type output, final validity and family matching", async (t) => {
  const g = await java(t);
  if (!g) return;
  try {
    const out = await collect(validateEventStream(g, events()));
    const start = out.find((e) => e.kind === "startElement");
    assert.equal(
      start.attributes.find((a) => a.name === "mode").specified,
      false,
    );
    assert.ok(start.type);
    assert.equal(
      start.attributes.find((a) => a.name === "mode").type.namespaceURI,
      "http://www.w3.org/2001/XMLSchema",
    );
    assert.equal(out.at(-1).result.valid, true);
    const invalid = await validateSource(
      g,
      { family: "stax", events: events("bad") },
      "events",
    );
    const invalidEvents = await collect(invalid.events);
    assert.equal((await invalid.completion).valid, false);
    assert.equal(
      invalidEvents.find((e) => e.kind === "diagnostic").diagnostic.provenance,
      "generated",
    );
    const stream = await validateSource(
      g,
      { family: "stream", source: "<r>3</r>" },
      "text",
    );
    assert.match(stream.text, /mode="normal"/);
    const input = parseXml("<r>3</r>"),
      before = serializeXml(input);
    const dom = await validateSource(g, { family: "dom", node: input }, "dom");
    assert.equal(dom.document.documentElement.getAttribute("mode"), "normal");
    assert.equal(serializeXml(input), before);
    await assert.rejects(
      validateSource(g, { family: "dom", node: input }, "text"),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
  } finally {
    g.dispose();
  }
});
test("real Java handler feeds push input without whole-document buffering and waits for final completion", async (t) => {
  const g = await java(t);
  if (!g) return;
  const handler = createValidationHandler(g, {
    output: "events",
    maxQueuedEvents: 2,
  });
  let sawStart = false;
  const consumed = (async () => {
    for await (const event of handler.events)
      if (event.kind === "startElement") {
        sawStart = true;
        assert.equal(g.disposed, false);
      }
  })();
  try {
    for (const event of events()) await handler.write(event);
    const result = await handler.end();
    await consumed;
    assert.equal(result.valid, true);
    assert.equal(sawStart, true);
  } finally {
    handler.abort();
    g.dispose();
  }
});
test("push queue is bounded with backpressure and downstream return closes input/provider", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let disposed = false,
    closed = false;
  const provider = {
    get disposed() {
      return disposed;
    },
    dispose() {
      disposed = true;
      release();
    },
    async validate() {
      return { valid: true, diagnostics: [] };
    },
    async *validateStream(chunks) {
      try {
        await gate;
        for await (const text of chunks) yield { kind: "text", text };
        yield { kind: "result", result: { valid: true, diagnostics: [] } };
      } finally {
        closed = true;
      }
    },
  };
  const handler = createValidationHandler(provider, { maxQueuedEvents: 1 });
  await handler.write(events()[0]);
  let settled = false;
  const waiting = handler.write(events()[1]).then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  release();
  await waiting;
  for (const event of events().slice(2)) await handler.write(event);
  assert.equal((await handler.end()).valid, true);
  assert.equal(closed, true);
  const nextProvider = {
    ...provider,
    async *validateStream(chunks) {
      try {
        for await (const text of chunks) yield { kind: "text", text };
      } finally {
        closed = true;
      }
    },
  };
  const next = createValidationHandler(nextProvider, {
    output: "events",
    maxQueuedEvents: 1,
  });
  const reading = (async () => {
    for await (const event of next.events) break;
  })();
  await next.write(events()[0]);
  await next.write(events()[1]);
  await reading;
  await assert.rejects(next.completion);
  assert.equal(disposed, true);
});
test("real Java incremental invalid-child diagnostics can arrive before input EOF and close upstream on return", async (t) => {
  const g = await java(
    t,
    '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r"><s:complexType><s:sequence><s:element name="a"/></s:sequence></s:complexType></s:element></s:schema>',
  );
  if (!g) return;
  let finish;
  const gate = new Promise((r) => (finish = r));
  let eof = false,
    closed = false;
  async function* source() {
    try {
      yield { kind: "startDocument" };
      yield { kind: "startElement", ...name("r"), attributes: [] };
      yield { kind: "startElement", ...name("b"), attributes: [] };
      yield { kind: "endElement", ...name("b") };
      await gate;
      eof = true;
      yield { kind: "endElement", ...name("r") };
      yield { kind: "endDocument" };
    } finally {
      closed = true;
    }
  }
  try {
    for await (const event of validateEventStream(g, source()))
      if (event.kind === "diagnostic") {
        assert.equal(eof, false);
        finish();
        break;
      }
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(closed, true);
  } finally {
    finish();
    g.dispose();
  }
});

// Browser-capable provider shares this structural event boundary; no Java import is required by the adapter.
test(
  "real Xerces events and matching collected outputs use native PSVI defaults and normalization",
  { timeout: 20000 },
  async () => {
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    const xsd =
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r"><s:complexType><s:sequence><s:element name="value" type="s:token" default="  hello   world "/></s:sequence><s:attribute name="mode" type="s:token" default="  alpha   beta "/></s:complexType></s:element></s:schema>';
    const g = await compileXercesSchema(xsd);
    try {
      const output = await validateSource(
        g,
        { family: "stream", source: "<r><value/></r>" },
        "text",
      );
      assert.equal(output.result.valid, true);
      assert.equal(
        parseXml(output.text).documentElement.firstElementChild.textContent,
        "hello world",
      );
      assert.equal(
        parseXml(output.text).documentElement.getAttribute("mode"),
        "alpha beta",
      );
      assert.equal((await g.validate(output.text)).valid, true);
      const source = [
        { kind: "startDocument" },
        { kind: "startElement", ...name("r"), attributes: [] },
        { kind: "startElement", ...name("value"), attributes: [] },
        { kind: "endElement", ...name("value") },
        { kind: "endElement", ...name("r") },
        { kind: "endDocument" },
      ];
      const native = await collect(validateEventStream(g, source));
      assert.equal(native.at(-1).result.valid, true);
      assert.equal(
        native.find((e) => e.kind === "endElement" && e.name === "value").psvi
          .normalizedValue,
        "hello world",
      );
    } finally {
      g.dispose();
    }
  },
);

test("factory language and feature/property getters expose only explicit snapshotted settings", async () => {
  const provider = {
    id: "explicit",
    version: "1",
    capabilities: { schemaLanguages: ["http://www.w3.org/2001/XMLSchema"] },
    features: { secure: [true] },
    properties: { limit: { defaultValue: 4 } },
    async compile() {
      return {};
    },
  };
  const factory = createSchemaFactory(provider);
  assert.equal(
    factory.supportsSchemaLanguage("http://www.w3.org/2001/XMLSchema"),
    true,
  );
  assert.equal(factory.supportsSchemaLanguage("unsupported"), false);
  assert.equal(factory.getFeature("secure"), true);
  assert.equal(factory.getProperty("limit"), 4);
  assert.throws(() => factory.getFeature("unknown"), {
    code: "UNSUPPORTED_CAPABILITY",
  });
  assert.throws(() => factory.compile("schema", { unknown: true }), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(
    () =>
      createSchemaFactory({
        ...provider,
        properties: { limit: { allowedValues: [{}] } },
      }),
    { code: "INVALID_ARGUMENT" },
  );
});
test(
  "invalid native QName defaults return no output; bound defaults preserve actual instance bindings",
  { timeout: 20000 },
  async () => {
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    const g = await compileXercesSchema(
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" xmlns:p="urn:default"><s:element name="r" type="s:QName" default="p:Thing"/></s:schema>',
    );
    try {
      const invalid = await validateSource(
        g,
        { family: "stream", source: "<r/>" },
        "text",
      );
      assert.equal(invalid.result.valid, false);
      assert.equal(invalid.text, undefined);
      for (const binding of ["urn:default", "urn:other"]) {
        const output = await validateSource(
          g,
          { family: "stream", source: `<r xmlns:p="${binding}"/>` },
          "text",
        );
        assert.equal(output.result.valid, true);
        assert.equal(
          parseXml(output.text).documentElement.lookupNamespaceURI("p"),
          binding,
        );
        assert.equal(
          parseXml(output.text).documentElement.textContent,
          "p:Thing",
        );
        assert.equal((await g.validate(output.text)).valid, true);
      }
    } finally {
      g.dispose();
    }
  },
);

test("event locator correlation preserves supplied positions and generated coordinates without guessing columns", async () => {
  const source = events("bad").map((event, i) => ({
    ...event,
    locator: { systemId: "urn:original", line: 10 + i * 10, column: 7 },
  }));
  const diagnostic = {
    message: "invalid integer",
    severity: "error",
    phase: "validate",
    line: 1,
    column: 11,
    systemId: "urn:generated",
  };
  let observed;
  const provider = {
    disposed: false,
    dispose() {},
    async validate() {
      return { valid: false, diagnostics: [diagnostic] };
    },
    async *validateStream(chunks) {
      const iterator = chunks[Symbol.asyncIterator]();
      await iterator.next();
      yield {
        kind: "startElement",
        ...name("r"),
        attributes: [],
        generatedLocator: { systemId: "urn:generated", line: 1, column: 4 },
      };
      for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
      }
      yield { kind: "diagnostic", diagnostic };
      yield {
        kind: "text",
        text: "injected",
        generatedLocator: { line: 1, column: 11 },
        generatedReason: "schema-default",
      };
      yield {
        kind: "result",
        result: { valid: false, diagnostics: [diagnostic] },
      };
    },
  };
  const output = await collect(
    validateEventStream(provider, source, {
      systemId: "urn:generated",
      onDiagnostic: (d) => (observed = d),
    }),
  );
  const start = output.find((e) => e.kind === "startElement");
  assert.equal(start.location.status, "event");
  assert.equal(start.location.source.line, 20);
  assert.equal(start.location.generated.column, 4);
  assert.equal(start.location.source.column, 7);
  const located = output.find((e) => e.kind === "diagnostic").diagnostic;
  assert.equal(
    located.location.source.line,
    40,
    "late reported end position maps to closing event, not earlier text",
  );
  assert.equal(located.location.precision, "event");
  assert.equal(located.column, 11, "native coordinate remains unchanged");
  assert.equal(
    output.find((e) => e.generatedReason).location.status,
    "generated",
  );
  assert.equal(output.at(-1).result.diagnostics[0].location.source.line, 40);
});
test("locator ambiguity, absent metadata, missing native coordinates and expired windows are explicit", async () => {
  async function run(
    column,
    source = events("bad"),
    maxLocatorSegments = 1024,
  ) {
    const d = {
      message: "reported position",
      severity: "error",
      line: 1,
      ...(column ? { column } : {}),
    };
    const provider = {
      disposed: false,
      dispose() {},
      async validate() {
        return { valid: false, diagnostics: [d] };
      },
      async *validateStream(chunks) {
        for await (const chunk of chunks) {
        }
        yield { kind: "diagnostic", diagnostic: d };
        yield { kind: "result", result: { valid: false, diagnostics: [d] } };
      },
    };
    return (
      await collect(
        validateEventStream(provider, source, { maxLocatorSegments }),
      )
    ).find((e) => e.kind === "diagnostic").location;
  }
  const located = events("bad").map((e, i) => ({
    ...e,
    locator: { line: 100 + i, column: 2 },
  }));
  assert.equal((await run(7, located)).status, "ambiguous");
  assert.equal((await run(9)).status, "missing-locator");
  assert.equal((await run(undefined, located)).status, "unmapped");
  assert.equal((await run(2, located, 2)).status, "expired");
});
test("XML event whitespace outside the root remains legal with CRLF normalization", async () => {
  const source = [
    { kind: "startDocument" },
    { kind: "text", text: "\r\n" },
    ...events().slice(1, -1),
    { kind: "text", text: "\r" },
    { kind: "endDocument" },
  ];
  assert.equal(
    parseXml((await collect(serializeValidationEvents(source))).join(""))
      .documentElement.textContent,
    "4",
  );
});

test(
  "actual Xerces callback locators correlate typed snapshots and late diagnostics to declared input event positions",
  { timeout: 20000 },
  async () => {
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    const g = await compileXercesSchema(
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r" type="s:int"/></s:schema>',
    );
    try {
      const source = events("bad").map((e, i) => ({
        ...e,
        locator: { systemId: "urn:original", line: 100 + i, column: 9 },
      }));
      const output = await collect(
        validateEventStream(g, source, { systemId: "urn:generated" }),
      );
      const start = output.find((e) => e.kind === "startElement");
      assert.equal(start.location.status, "event");
      assert.equal(start.location.source.line, 101);
      assert.equal(start.location.generated.line, 1);
      const diagnostic = output.find((e) => e.kind === "diagnostic");
      assert.equal(diagnostic.location.status, "event");
      assert.equal(diagnostic.location.source.line, 103);
      assert.equal(diagnostic.diagnostic.provenance, "generated");
      assert.equal(output.at(-1).result.valid, false);
    } finally {
      g.dispose();
    }
  },
);

test(
  "namespace-prefixes feature preserves prefix events and conditionally exposes namespace declaration attributes",
  { timeout: 20000 },
  async (t) => {
    const xsd =
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:r"><s:element name="r"><s:complexType><s:anyAttribute processContents="skip"/></s:complexType></s:element></s:schema>';
    const source = [
      { kind: "startDocument" },
      { kind: "startPrefixMapping", prefix: "", namespaceURI: "urn:r" },
      { kind: "startPrefixMapping", prefix: "p", namespaceURI: "urn:p" },
      {
        kind: "startElement",
        ...name("r", "urn:r"),
        attributes: [{ ...name("p:a", "urn:p"), value: "value" }],
      },
      { kind: "endElement", ...name("r", "urn:r") },
      { kind: "endPrefixMapping", prefix: "p" },
      { kind: "endPrefixMapping", prefix: "" },
      { kind: "endDocument" },
    ];
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    for (const g of [await java(t, xsd), await compileXercesSchema(xsd)]) {
      if (!g) continue;
      try {
        for (const enabled of [false, true]) {
          const output = await collect(
            validateEventStream(g, source, { namespacePrefixes: enabled }),
          );
          const root = output.find((e) => e.kind === "startElement");
          assert.equal(
            output.filter((e) => e.kind === "startPrefixMapping").length,
            2,
          );
          assert.equal(
            root.attributes.filter(
              (a) => a.namespaceURI === "http://www.w3.org/2000/xmlns/",
            ).length,
            enabled ? 2 : 0,
          );
          if (enabled) {
            assert.equal(
              root.attributes.find((a) => a.name === "xmlns").localName,
              "xmlns",
            );
            assert.equal(
              root.attributes.find((a) => a.name === "xmlns:p").localName,
              "p",
            );
            assert.equal(
              root.attributes.find((a) => a.name === "xmlns:p")
                .namespaceDeclaration,
              true,
            );
            assert.equal(
              root.attributes.find((a) => a.name === "xmlns:p").type,
              null,
            );
          }
          assert.equal(output.at(-1).result.valid, true);
        }
      } finally {
        g.dispose();
      }
    }
  },
);

test(
  "pipeline forwards exact diagnostic handlers with correlated event locations and sentinel identity",
  { timeout: 30000 },
  async (t) => {
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    const schema =
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r" type="s:int"/></s:schema>';
    const source = () =>
      events("bad").map((event, i) => ({
        ...event,
        locator: { systemId: "urn:original", line: 40 + i, column: 5 },
      }));
    const raw = await compileXercesSchema(schema);
    const sentinel = { stop: "raw-handler" };
    let rawSeen;
    try {
      await assert.rejects(
        collect(
          validateEventStream(raw, source(), {
            diagnosticHandler: (diagnostic) => {
              rawSeen = diagnostic;
              throw sentinel;
            },
          }),
        ),
        (error) => error === sentinel,
      );
      assert.equal(rawSeen.location.status, "event");
      assert.equal(rawSeen.location.source.line, 43);
      assert.equal(rawSeen.provenance, "generated");
    } finally {
      raw.dispose();
    }
    const javaSchema = await java(t, schema);
    if (javaSchema) {
      let finished = false;
      try {
        const output = await collect(
          validateEventStream(javaSchema, source(), {
            diagnosticHandler: async (diagnostic) => {
              assert.equal(diagnostic.location.source.line, 43);
              await new Promise((resolve) => setTimeout(resolve, 15));
              finished = true;
            },
          }),
        );
        assert.equal(finished, true);
        assert.equal(output.at(-1).result.valid, false);
      } finally {
        javaSchema.dispose();
      }
    }
    const { compileIsolatedXercesSchema } = await import(
      "../dist/schema-xerces-isolated.js"
    );
    const isolated = await compileIsolatedXercesSchema(schema);
    const isolatedSentinel = { stop: "isolated-handler" };
    try {
      await assert.rejects(
        collect(
          validateEventStream(isolated, source(), {
            diagnosticHandler: async (diagnostic) => {
              assert.equal(diagnostic.location.source.line, 43);
              await Promise.resolve();
              throw isolatedSentinel;
            },
          }),
        ),
        (error) => error === isolatedSentinel,
      );
    } finally {
      isolated.dispose();
    }
  },
);
test(
  "matching source handlers retain original byte and generated DOM provenance",
  { timeout: 20000 },
  async (t) => {
    const g = await java(
      t,
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r" type="s:int"/></s:schema>',
    );
    if (!g) return;
    try {
      const diagnostics = [];
      await validateSource(
        g,
        {
          family: "stream",
          source: {
            kind: "bytes",
            bytes: new TextEncoder().encode("<r>bad</r>"),
            systemId: "urn:byte-input",
          },
        },
        "none",
        {
          diagnosticHandler: async (d) => {
            diagnostics.push(d);
          },
        },
      );
      assert.equal(diagnostics[0].sourceKind, "bytes");
      assert.equal(diagnostics[0].provenance, "original");
      diagnostics.length = 0;
      await validateSource(
        g,
        { family: "dom", node: parseXml("<r>bad</r>") },
        "none",
        {
          diagnosticHandler: (d) => {
            diagnostics.push(d);
          },
        },
      );
      assert.equal(diagnostics[0].sourceKind, "dom");
      assert.equal(diagnostics[0].provenance, "generated");
    } finally {
      g.dispose();
    }
  },
);
test(
  "collected output preserves prolog, simple-content and epilog processing instructions",
  { timeout: 30000 },
  async (t) => {
    const schema =
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r" type="s:string"/></s:schema>';
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    for (const g of [
      await compileXercesSchema(schema),
      await java(t, schema),
    ]) {
      if (!g) continue;
      try {
        const output = await validateSource(
          g,
          {
            family: "stream",
            source: "<?before a?><r>a<?inside d?>b</r><?after z?>",
          },
          "text",
        );
        assert.equal(output.result.valid, true);
        assert.match(
          output.text,
          /^<\?before a\?><r>a<\?inside d\?>b<\/r><\?after z\?>$/,
        );
        assert.equal((await g.validate(output.text)).valid, true);
      } finally {
        g.dispose();
      }
    }
  },
);
test(
  "collected namespaced default attributes use their actual expanded names and bound prefixes",
  { timeout: 30000 },
  async (t) => {
    const schema =
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:r" elementFormDefault="qualified" attributeFormDefault="qualified"><s:element name="r"><s:complexType><s:attribute name="flag" type="s:string" default="yes"/></s:complexType></s:element></s:schema>';
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    for (const g of [
      await compileXercesSchema(schema),
      await java(t, schema),
    ]) {
      if (!g) continue;
      try {
        const output = await validateSource(
          g,
          { family: "stream", source: '<r xmlns="urn:r"/>' },
          "text",
        );
        assert.equal(output.result.valid, true);
        const document = parseXml(output.text);
        assert.equal(
          document.documentElement.getAttributeNS("urn:r", "flag"),
          "yes",
        );
        assert.equal((await g.validate(output.text)).valid, true);
      } finally {
        g.dispose();
      }
    }
  },
);

test(
  "matching adapters charge original byte sources once and retain inherited and output byte ceilings",
  { timeout: 30000 },
  async (t) => {
    const schema =
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="root" type="s:string"/></s:schema>';
    const text = "<root>é</root>",
      bytes = Buffer.from(text, "latin1"),
      cap = bytes.length;
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    const { compileIsolatedXercesSchema } = await import(
      "../dist/schema-xerces-isolated.js"
    );
    const providers = [
      await compileXercesSchema(schema, { maxBytes: cap }),
      await compileIsolatedXercesSchema(schema, { maxBytes: cap }),
    ];
    try {
      try {
        providers.push(
          await compileJavaSchema(schema, { maxBytes: cap, timeoutMs: 15000 }),
        );
      } catch (error) {
        if (
          error.code !== "ENGINE_UNAVAILABLE" ||
          process.env.XMLWEAVE_REQUIRE_JAVA
        )
          throw error;
      }
      for (const provider of providers) {
        const source = { kind: "bytes", bytes, encoding: "ISO-8859-1" };
        assert.equal(
          (
            await validateSource(
              provider,
              { family: "stream", source },
              "none",
              { maxBytes: cap },
            )
          ).result.valid,
          true,
        );
        const output = await validateSource(
          provider,
          { family: "stream", source },
          "text",
          { maxBytes: cap },
        );
        assert.equal(parseXml(output.text).documentElement.textContent, "é");
        assert.equal(
          (
            await validateSource(
              provider,
              { family: "dom", node: parseXml(text) },
              "dom",
            )
          ).result.valid,
          true,
        );
        await assert.rejects(
          validateSource(provider, { family: "stream", source }, "bytes", {
            maxBytes: cap,
          }),
          { code: "RESOURCE_LIMIT" },
          "output UTF8 byte budget remains independent",
        );
        await assert.rejects(
          validateSource(
            provider,
            {
              family: "stream",
              source: {
                kind: "bytes",
                bytes: Buffer.from("<root>éé</root>", "latin1"),
                encoding: "ISO-8859-1",
              },
            },
            "none",
          ),
          { code: "RESOURCE_LIMIT" },
          "omitted operation budget must retain the compiled original-byte ceiling",
        );
        await assert.rejects(
          validateSource(provider, { family: "stream", source }, "none", {
            maxBytes: cap + 1,
          }),
          { code: "INVALID_ARGUMENT" },
          "public overrides cannot raise inherited processing limits",
        );
      }
    } finally {
      for (const provider of providers) provider.dispose();
    }
  },
);
test(
  "matching buffered sources abort and dispose pending producers and request iterator closure",
  { timeout: 30000 },
  async () => {
    const schema =
      '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r" type="s:string"/></s:schema>';
    const { compileXercesSchema } = await import("../dist/schema-xerces.js");
    const { compileIsolatedXercesSchema } = await import(
      "../dist/schema-xerces-isolated.js"
    );
    for (const compile of [compileXercesSchema, compileIsolatedXercesSchema])
      for (const mode of ["abort", "dispose"]) {
        const provider = await compile(schema);
        const signal = { aborted: false };
        let closed = 0,
          read = 0;
        const chunks = {
          [Symbol.asyncIterator]() {
            return {
              next() {
                read++;
                return new Promise(() => {});
              },
              return() {
                closed++;
                return Promise.resolve({ done: true });
              },
            };
          },
        };
        const pending = validateSource(
          provider,
          { family: "stream", source: { kind: "chunks", chunks } },
          "none",
          { signal },
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (mode === "abort") signal.aborted = true;
        else provider.dispose();
        try {
          await assert.rejects(pending, {
            code: mode === "abort" ? "ABORTED" : "DISPOSED",
          });
          assert.equal(read, 1);
          assert.equal(closed, 1);
          if (mode === "abort")
            assert.equal(
              (
                await validateSource(
                  provider,
                  { family: "stream", source: "<r/>" },
                  "none",
                )
              ).result.valid,
              true,
            );
        } finally {
          provider.dispose();
        }
      }
  },
);

test('public normalized source results cannot forge the private UTF8 transport brand',{timeout:20000},async()=>{
 const schemaModule=await import('../dist/schema.js');assert.equal(schemaModule.markNormalizedTransport,undefined);assert.equal(schemaModule.getNormalizedTransport,undefined);assert.equal(schemaModule.recordNormalizedSourceBytes,undefined);
 const {compileXercesSchema}=await import('../dist/schema-xerces.js');const text='<root>é</root>',bytes=Buffer.from(text,'latin1');const normalized=await schemaModule.normalizeSchemaSource({kind:'bytes',bytes,encoding:'ISO-8859-1'});normalized[Symbol.iterator]=function*(){yield text;};const provider=await compileXercesSchema('<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="root" type="s:string"/></s:schema>',{maxBytes:bytes.length});try{await assert.rejects(collect(provider.validateStream(normalized)),{code:'RESOURCE_LIMIT'});}finally{provider.dispose();}
});

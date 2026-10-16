import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileJavaSchema } from "../dist/schema-java.js";
const xs = "http://www.w3.org/2001/XMLSchema";
test("Java actual XS graph answers all DOM masks and no-namespace targets without JDK TypeInfo defects", async () => {
  const xsd = `<xs:schema xmlns:xs="${xs}"><xs:simpleType name="R"><xs:restriction base="xs:int"/></xs:simpleType><xs:simpleType name="L"><xs:list itemType="R"/></xs:simpleType><xs:simpleType name="U"><xs:union memberTypes="R xs:boolean"/></xs:simpleType><xs:complexType name="B"><xs:sequence/></xs:complexType><xs:complexType name="E"><xs:complexContent><xs:extension base="B"/></xs:complexContent></xs:complexType><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="r" type="R"/><xs:element name="l" type="L"/><xs:element name="u" type="U"/><xs:element name="b" type="B"/><xs:element name="e" type="E"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
  const targets = [
    ["anyType", xs],
    ["anySimpleType", xs],
    ["decimal", xs],
    ["int", xs],
    ["boolean", xs],
    ["R", ""],
    ["L", ""],
    ["U", ""],
    ["B", ""],
    ["E", ""],
  ];
  const typeQueries = targets.flatMap(([name, namespaceURI]) =>
    Array.from({ length: 16 }, (_, method) => ({ name, namespaceURI, method })),
  );
  const expected = {
    r: [1, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    l: [9, 9, 8, 8, 0, 8, 1, 0, 0, 0],
    u: [1, 1, 0, 0, 1, 0, 0, 0, 0, 0],
    b: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0],
    e: [2, 0, 0, 0, 0, 0, 0, 0, 2, 1],
    root: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  const compiled = await compileJavaSchema(xsd, { typeQueries });
  try {
    let comparisons = 0;
    for await (const event of compiled.validateStream([
      "<root><r>1</r><l>1 2</l><u>true</u><b/><e/></root>",
    ]))
      if (event.kind === "endElement") {
        const relationships = expected[event.name];
        for (let target = 0; target < targets.length; target++)
          for (let method = 0; method < 16; method++) {
            const bits = relationships[target];
            assert.equal(
              event.type.derivations[target * 16 + method],
              method === 0 ? bits !== 0 : (bits & method) !== 0,
              `${event.name} -> ${targets[target][0]} method ${method}`,
            );
            comparisons++;
          }
        assert.equal(event.type.qNameValue, false);
      }
    assert.equal(comparisons, 960);
  } finally {
    compiled.dispose();
  }
});
test("Java zero-mask traversal reaches later union member list items while named methods remain false", async () => {
  const xsd = `<xs:schema xmlns:xs="${xs}"><xs:simpleType name="L"><xs:list itemType="xs:int"/></xs:simpleType><xs:simpleType name="U"><xs:union memberTypes="xs:boolean L"/></xs:simpleType><xs:element name="root" type="U"/></xs:schema>`;
  const compiled = await compileJavaSchema(xsd, {
    typeQueries: Array.from({ length: 16 }, (_, method) => ({
      namespaceURI: xs,
      name: "int",
      method,
    })),
  });
  try {
    const events = [];
    for await (const event of compiled.validateStream(["<root>1 2</root>"]))
      events.push(event);
    const start = events.find((e) => e.kind === "startElement");
    assert.equal(start.type.name, "U");
    assert.deepEqual(start.type.derivations, [true, ...Array(15).fill(false)]);
    assert.equal(events.find((e) => e.kind === "endElement").type.name, "L");
    assert.equal(events.at(-1).result.valid, true);
  } finally {
    compiled.dispose();
  }
});
test("Java isolates compile handlers and preserves original byte budgets in validation and output", async () => {
  const signal = { aborted: false };
  let observed = 0;
  const compiled = await compileJavaSchema(
    `<xs:schema xmlns:xs="${xs}"><xs:element name="root" type="xs:string"/></xs:schema>`,
    {
      maxBytes: 300,
      signal,
      errorPolicy: "throw",
      onDiagnostic() {
        observed++;
      },
    },
  );
  signal.aborted = true;
  try {
    assert.equal((await compiled.validate("<wrong/>")).valid, false);
    assert.equal(observed, 0);
    const xml =
      '<?xml version="1.0" encoding="ISO-8859-1"?><root>' +
      "é".repeat(200) +
      "</root>";
    const bytes = Buffer.from(xml, "latin1");
    assert.ok(bytes.length < 300);
    assert.ok(Buffer.byteLength(xml) > 300);
    assert.equal(
      (await compiled.validate({ kind: "bytes", bytes })).valid,
      true,
    );
    assert.equal(
      (await compiled.validateOutput({ kind: "bytes", bytes })).result.valid,
      true,
    );
    await assert.rejects(
      compiled.validate(
        {
          kind: "bytes",
          bytes: Buffer.from("<root>" + "a".repeat(310) + "</root>"),
        },
        { maxBytes: undefined },
      ),
      (e) => e.code === "RESOURCE_LIMIT",
    );
    const session = compiled.createValidator({ maxCharacters: 5 });
    try {
      await assert.rejects(
        session.validate("<root/>"),
        (e) => e.code === "RESOURCE_LIMIT",
      );
    } finally {
      session.dispose();
    }
  } finally {
    compiled.dispose();
  }
});
test("Java diagnostic acknowledgement stops before requesting more input", async () => {
  const xsd = `<xs:schema xmlns:xs="${xs}"><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="n" type="xs:int"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
  const compiled = await compileJavaSchema(xsd);
  let advanced = false,
    closed = false;
  async function* source() {
    try {
      yield "<root><n>bad</n><n/>";
      advanced = true;
      yield "</root>";
    } finally {
      closed = true;
    }
  }
  await assert.rejects(
    (async () => {
      for await (const event of compiled.validateStream(source(), {
        errorPolicy: "throw",
      })) {
      }
    })(),
    (error) => error.code === "INVALID_XML",
  );
  assert.equal(advanced, false);
  assert.equal(closed, true);
  assert.equal(compiled.disposed, true);
});
test("Java event snapshots preserve parser positions and mark supplied default content", async () => {
  const compiled = await compileJavaSchema(
    `<xs:schema xmlns:xs="${xs}"><xs:element name="root" type="xs:token" default="  hello world "/></xs:schema>`,
  );
  try {
    const events = [];
    for await (const event of compiled.validateStream(["<?before x?><root/>"]))
      events.push(event);
    assert.equal(
      events.find((e) => e.kind === "processingInstruction").generatedLocator
        .line,
      1,
    );
    assert.equal(
      events.find((e) => e.kind === "startElement").generatedLocator.line,
      1,
    );
    assert.equal(
      events.find((e) => e.kind === "text").generatedReason,
      "schema-default",
    );
    assert.equal(events.find((e) => e.kind === "endElement").specified, false);
  } finally {
    compiled.dispose();
  }
});
test("Java reference records schema-only QName default prefix differential", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/validation-qname-default.json", import.meta.url),
      "utf8",
    ),
  );
  const compiled = await compileJavaSchema(fixture.schema);
  try {
    const events = [];
    for await (const event of compiled.validateStream([fixture.xml]))
      events.push(event);
    assert.equal(events.at(-1).result.valid, fixture.observed.java17.valid);
    assert.equal(
      events
        .filter((e) => e.kind === "text")
        .map((e) => e.text)
        .join(""),
      fixture.observed.java17.emittedText,
    );
    assert.equal(
      events.some((e) => e.kind === "startPrefixMapping" && e.prefix === "p"),
      false,
    );
    assert.equal(events.find((e) => e.kind === "endElement").specified, false);
    assert.equal(
      events.find((e) => e.kind === "endElement").type.qNameValue,
      true,
    );
    assert.equal((await compiled.validate(fixture.lexicalOutput)).valid, false);
  } finally {
    compiled.dispose();
  }
});
const schema = `<xs:schema xmlns:xs="${xs}"><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="n" type="xs:int"/></xs:sequence><xs:attribute name="mode" type="xs:token" default="hi there"/><xs:attribute name="id" type="xs:ID"/></xs:complexType></xs:element></xs:schema>`;
test("Java provider preserves source diagnostics, recovers, supplies real default/type/ID snapshots", async () => {
  const compiled = await compileJavaSchema(schema, {
    timeoutMs: 15000,
    typeQueries: [{ namespaceURI: xs, name: "decimal", method: 0 }],
  });
  try {
    const invalid = await compiled.validate({
      kind: "text",
      text: "<root>\n<n>bad</n></root>",
      systemId: "https://example.test/input.xml",
    });
    assert.equal(invalid.valid, false);
    assert.equal(
      invalid.diagnostics[0].systemId,
      "https://example.test/input.xml",
    );
    assert.equal(invalid.diagnostics[0].line, 2);
    const events = [];
    for await (const event of compiled.validateStream([
      '<root id="abc"><n>4</n></root>',
    ]))
      events.push(event);
    const root = events.find((e) => e.kind === "startElement");
    assert.equal(
      root.attributes.find((a) => a.name === "mode").specified,
      false,
    );
    assert.equal(root.attributes.find((a) => a.name === "id").isId, true);
    const n = events.find((e) => e.kind === "endElement" && e.name === "n");
    assert.equal(n.type.name, "int");
    assert.equal(n.type.derivations[0], true);
    assert.ok(Object.isFrozen(n.type));
    assert.equal(events.at(-1).result.valid, true);
  } finally {
    compiled.dispose();
  }
});
test("Java typed events are delivered before EOF, with upstream closure on early return", async () => {
  const compiled = await compileJavaSchema(schema, { timeoutMs: 15000 });
  let release;
  const gate = new Promise((r) => (release = r));
  let eof = false,
    closed = false;
  async function* chunks() {
    try {
      yield "<root><n>1</n>";
      await gate;
      eof = true;
      yield "</root>";
    } finally {
      closed = true;
    }
  }
  try {
    for await (const event of compiled.validateStream(chunks())) {
      if (event.kind === "startElement") {
        assert.equal(eof, false);
        release();
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, true);
    assert.equal(compiled.disposed, true);
  } finally {
    release();
    compiled.dispose();
  }
});
test("Java safe catalogue supports includes and denies unknown resources/DTDs", async () => {
  const root = {
    kind: "text",
    systemId: "https://example.test/root.xsd",
    text: `<xs:schema xmlns:xs="${xs}"><xs:include schemaLocation="part.xsd"/><xs:element name="n" type="T"/></xs:schema>`,
  };
  const part = {
    kind: "text",
    systemId: "https://example.test/part.xsd",
    text: `<xs:schema xmlns:xs="${xs}"><xs:simpleType name="T"><xs:restriction base="xs:int"/></xs:simpleType></xs:schema>`,
  };
  const compiled = await compileJavaSchema([root, part], { timeoutMs: 15000 });
  try {
    assert.equal((await compiled.validate("<n>4</n>")).valid, true);
    assert.equal(
      (await compiled.validate('<!DOCTYPE n [<!ENTITY x "4">]><n>&x;</n>'))
        .valid,
      false,
    );
  } finally {
    compiled.dispose();
  }
  await assert.rejects(
    compileJavaSchema(root, { timeoutMs: 15000 }),
    (e) => e.code === "INVALID_SCHEMA",
  );
});
test("Java missing runtime, deadline, independent sessions and reset have stable behavior", async () => {
  await assert.rejects(
    compileJavaSchema(schema, {
      javaExecutable: "xmlweave-nonexistent-java-executable",
      timeoutMs: 15000,
    }),
    (e) => e.code === "ENGINE_UNAVAILABLE",
  );
  const compiled = await compileJavaSchema(schema, { timeoutMs: 15000 });
  const a = compiled.createValidator(),
    b = compiled.createValidator();
  try {
    const results = await Promise.all([
      a.validate("<root><n>2</n></root>"),
      b.validate("<root><n>3</n></root>"),
    ]);
    assert.ok(results.every((r) => r.valid));
    a.reset();
    assert.equal((await a.validate("<root><n>bad</n></root>")).valid, false);
    a.reset();
    assert.equal((await a.validate("<root><n>4</n></root>")).valid, true);
    await assert.rejects(
      (async () => {
        for await (const event of compiled.validateStream(
          (async function* () {
            yield "<root>";
            await new Promise((r) => setTimeout(r, 200));
            yield "</root>";
          })(),
          { timeoutMs: 50 },
        )) {
        }
      })(),
      (e) => e.code === "TIMEOUT",
    );
  } finally {
    a.dispose();
    b.dispose();
    compiled.dispose();
  }
});

test("Java output contains engine default content and actual union-member and xsi:type information", async () => {
  const xsd = `<xs:schema xmlns:xs="${xs}"><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="default" type="xs:token" default="  hello   world "/><xs:element name="value"><xs:simpleType><xs:union memberTypes="xs:int xs:boolean"/></xs:simpleType></xs:element><xs:element name="dynamic" type="xs:anyType"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
  const compiled = await compileJavaSchema(xsd, { timeoutMs: 15000 });
  const input = `<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="${xs}"><default/><value>true</value><dynamic xsi:type="xs:int">7</dynamic></root>`;
  try {
    const output = await compiled.validateOutput(input);
    assert.equal(output.result.valid, true);
    assert.match(output.xml, /<default>hello world<\/default>/);
    assert.equal(
      output.document.documentElement.firstElementChild.textContent,
      "hello world",
    );
    const events = [];
    for await (const e of compiled.validateStream([input])) events.push(e);
    assert.equal(
      events.find((e) => e.kind === "endElement" && e.name === "value").type
        .name,
      "boolean",
    );
    assert.equal(
      events.find((e) => e.kind === "endElement" && e.name === "dynamic").type
        .name,
      "int",
    );
  } finally {
    compiled.dispose();
  }
});
test("Java cancellation, limits, callback identity and option rejection release native work", async () => {
  const callbackError = new Error("observer stop");
  const first = await compileJavaSchema(schema, { timeoutMs: 15000 });
  await assert.rejects(
    first.validate("<root><n>bad</n></root>", {
      onDiagnostic() {
        throw callbackError;
      },
    }),
    (e) => e === callbackError,
  );
  assert.equal(first.disposed, true);
  const second = await compileJavaSchema(schema, { timeoutMs: 15000 });
  try {
    await assert.rejects(
      second.validate("<root><n>1</n></root>", { maxCharacters: 5 }),
      (e) => e.code === "RESOURCE_LIMIT",
    );
    await assert.rejects(
      second.validate("<root><n>1</n></root>", { maxDiagnostics: 0 }),
      (e) => e.code === "INVALID_ARGUMENT",
    );
    const signal = { aborted: false };
    await assert.rejects(
      (async () => {
        for await (const e of second.validateStream(
          (async function* () {
            yield "<root>";
            signal.aborted = true;
            await new Promise((r) => setTimeout(r, 100));
            yield "</root>";
          })(),
          { signal },
        )) {
        }
      })(),
      (e) => e.code === "ABORTED",
    );
    assert.equal(second.disposed, true);
  } finally {
    second.dispose();
  }
});

test("Java invalid iterator acquisition rejects safely and the process remains reusable", async () => {
  const compiled = await compileJavaSchema(schema, { timeoutMs: 15000 });
  try {
    for (const chunks of [
      {},
      {
        [Symbol.iterator]() {
          throw new Error("broken iterator");
        },
      },
      {
        [Symbol.iterator]() {
          return {};
        },
      },
    ])
      await assert.rejects(
        (async () => {
          for await (const event of compiled.validateStream(chunks)) {
          }
        })(),
        { code: "INVALID_ARGUMENT" },
      );
    assert.equal(compiled.disposed, false);
    assert.equal(
      (await compiled.validate("<root><n>1</n></root>")).valid,
      true,
    );
  } finally {
    compiled.dispose();
  }
});
test("Java generated output safely serializes the CDATA terminator and preserves decoded text", async () => {
  const compiled = await compileJavaSchema(
    `<xs:schema xmlns:xs="${xs}"><xs:element name="r" type="xs:string"/></xs:schema>`,
    { timeoutMs: 15000 },
  );
  try {
    const output = await compiled.validateOutput("<r>]]&gt;</r>");
    assert.equal(output.result.valid, true);
    assert.equal(output.document.documentElement.textContent, "]]>");
    assert.match(output.xml, /&gt;/);
  } finally {
    compiled.dispose();
  }
});
test("Java strict options fail before process/session mutation and safety limits only narrow", async () => {
  await assert.rejects(compileJavaSchema(schema, { unknownOption: true }), {
    code: "INVALID_ARGUMENT",
  });
  const compiled = await compileJavaSchema(schema, {
    timeoutMs: 15000,
    maxCharacters: 1000,
  });
  try {
    assert.throws(() => compiled.createValidator({ unknownOption: true }), {
      code: "INVALID_ARGUMENT",
    });
    await assert.rejects(
      compiled.validate("<root><n>1</n></root>", { unknownOption: true }),
      { code: "INVALID_ARGUMENT" },
    );
    await assert.rejects(
      compiled.validate("<root><n>1</n></root>", { maxCharacters: 1001 }),
      { code: "INVALID_ARGUMENT" },
    );
    await assert.rejects(
      compiled.validate("<root><n>1</n></root>", { javaExecutable: "java" }),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
    const session = compiled.createValidator({ maxCharacters: 500 });
    try {
      await assert.rejects(
        session.validate("<root><n>1</n></root>", { maxCharacters: 501 }),
        { code: "INVALID_ARGUMENT" },
      );
      session.reset();
      assert.equal(
        (await session.validate("<root><n>1</n></root>")).valid,
        true,
      );
    } finally {
      session.dispose();
    }
    assert.equal(
      (await compiled.validate("<root><n>1</n></root>")).valid,
      true,
    );
  } finally {
    compiled.dispose();
  }
});
test("Java normalized byte and DOM source diagnostics retain provenance and callback exceptions win teardown", async () => {
  const compiled = await compileJavaSchema(schema, { timeoutMs: 15000 });
  try {
    const result = await compiled.validate({
      kind: "bytes",
      bytes: new TextEncoder().encode("<root><n>bad</n></root>"),
      systemId: "urn:byte-input",
    });
    assert.equal(result.diagnostics[0].sourceKind, "bytes");
    assert.equal(result.diagnostics[0].provenance, "original");
  } finally {
    compiled.dispose();
  }
  const other = await compileJavaSchema(schema, { timeoutMs: 15000 });
  const sentinel = new Error("callback identity");
  const input = {
    [Symbol.iterator]() {
      let done = false;
      return {
        next() {
          if (done) return { done: true };
          done = true;
          return { value: "<root><n>bad</n></root>", done: false };
        },
        return() {
          throw new Error("teardown must not replace callback");
        },
      };
    },
  };
  try {
    await assert.rejects(
      (async () => {
        for await (const event of other.validateStream(input, {
          onDiagnostic() {
            throw sentinel;
          },
        })) {
        }
      })(),
      (error) => error === sentinel,
    );
    assert.equal(other.disposed, true);
  } finally {
    other.dispose();
  }
});

test("Java namespace-only imports resolve unambiguous supplied namespaces and reject ambiguous catalogues", async () => {
  const root = {
    kind: "text",
    systemId: "https://catalog.invalid/root.xsd",
    text: `<xs:schema xmlns:xs="${xs}" xmlns:t="urn:types"><xs:import namespace="urn:types"/><xs:element name="r" type="t:Code"/></xs:schema>`,
  };
  const part = {
    kind: "text",
    systemId: "https://catalog.invalid/part.xsd",
    text: `<xs:schema xmlns:xs="${xs}" targetNamespace="urn:types"><xs:simpleType name="Code"><xs:restriction base="xs:int"/></xs:simpleType></xs:schema>`,
  };
  const compiled = await compileJavaSchema([root, part], { timeoutMs: 15000 });
  try {
    assert.equal((await compiled.validate("<r>1</r>")).valid, true);
    assert.equal((await compiled.validate("<r>x</r>")).valid, false);
  } finally {
    compiled.dispose();
  }
  const other = {
    ...part,
    systemId: "https://catalog.invalid/other.xsd",
    text: part.text.replace('name="Code"', 'name="Other"'),
  };
  await assert.rejects(
    compileJavaSchema([root, part, other], { timeoutMs: 15000 }),
    (error) =>
      error.code === "INVALID_SCHEMA" &&
      /Ambiguous namespace-only/.test(error.message),
  );
});

test(
  "anonymous type identities remain stable and support retained graph queries",
  { timeout: 20000 },
  async () => {
    const schema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r"><xs:complexType><xs:sequence><xs:element name="a"><xs:simpleType><xs:restriction base="xs:int"/></xs:simpleType></xs:element><xs:element name="b"><xs:simpleType><xs:restriction base="xs:int"/></xs:simpleType></xs:element></xs:sequence></xs:complexType></xs:element></xs:schema>`;
    const compiled = await compileJavaSchema(schema);
    const other = await compileJavaSchema(schema);
    const collect = async () => {
      const types = [];
      for await (const event of compiled.validateStream([
        "<r><a>1</a><b>2</b></r>",
      ]))
        if (event.kind === "endElement")
          types.push(event.psvi?.type ?? event.type);
      return types;
    };
    try {
      const first = await collect(),
        second = await collect();
      assert.equal(first[0].anonymous, true);
      assert.notDeepEqual(first[0].identity, first[1].identity);
      assert.deepEqual(first[0].identity, second[0].identity);
      assert.equal(
        await compiled.queryTypeDerivation(
          first[0].identity,
          first[0].identity,
          0,
        ),
        true,
      );
      assert.equal(
        await compiled.queryTypeDerivation(
          first[0].identity,
          { namespaceURI: "http://www.w3.org/2001/XMLSchema", name: "int" },
          1,
        ),
        true,
      );
      await assert.rejects(
        other.queryTypeDerivation(first[0].identity, first[0].identity),
        (e) => e.code === "INVALID_ARGUMENT",
      );
    } finally {
      compiled.dispose();
      other.dispose();
    }
  },
);

test(
  "default namespaced attributes receive actual scoped namespace bindings",
  { timeout: 20000 },
  async () => {
    const X = "http://www.w3.org/2001/XMLSchema";
    const compiled = await compileJavaSchema([
      {
        kind: "text",
        systemId: "https://a/root.xsd",
        text: `<xs:schema xmlns:xs="${X}" xmlns:p="urn:a"><xs:import namespace="urn:a" schemaLocation="attr.xsd"/><xs:element name="r"><xs:complexType><xs:attribute ref="p:a" default="yes"/></xs:complexType></xs:element></xs:schema>`,
      },
      {
        kind: "text",
        systemId: "https://a/attr.xsd",
        text: `<xs:schema xmlns:xs="${X}" targetNamespace="urn:a"><xs:attribute name="a" type="xs:string"/></xs:schema>`,
      },
    ]);
    try {
      const events = [];
      for await (const event of compiled.validateStream([
        '<r xmlns:ns1="urn:occupied"/>',
      ]))
        events.push(event);
      const start = events.find((e) => e.kind === "startElement"),
        mapping = events.find(
          (e) => e.kind === "startPrefixMapping" && e.namespaceURI === "urn:a",
        );
      assert.ok(mapping);
      assert.notEqual(mapping.prefix, "ns1");
      assert.equal(start.attributes[0].name, `${mapping.prefix}:a`);
      assert.equal(events.at(-1).result.valid, true);
      assert.ok(
        events.find(
          (e) => e.kind === "endPrefixMapping" && e.prefix === mapping.prefix,
        ),
      );
      assert.equal(
        (
          await compiled.validate(
            `<r xmlns:${mapping.prefix}="urn:a" ${mapping.prefix}:a="yes"/>`,
          )
        ).valid,
        true,
      );
    } finally {
      compiled.dispose();
    }
  },
);

test(
  "Java awaitable diagnostic handler pauses engine and preserves custom rejection",
  { timeout: 20000 },
  async () => {
    const compiled = await compileJavaSchema(
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r" type="xs:int"/></xs:schema>',
    );
    const failure = { custom: true };
    let calls = 0;
    try {
      await assert.rejects(
        compiled.validate("<r>bad</r>", {
          diagnosticHandler: async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw failure;
          },
        }),
        (error) => error === failure,
      );
      assert.equal(calls, 1);
    } finally {
      compiled.dispose();
    }
  },
);

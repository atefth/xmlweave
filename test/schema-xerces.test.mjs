import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileXercesSchema } from "../dist/schema-xerces.js";
const xs = "http://www.w3.org/2001/XMLSchema";
test(
  "Xerces zero-mask traversal follows a later union member list without conflating selected member type",
  { timeout: 20000 },
  async () => {
    const xsd = `<xs:schema xmlns:xs="${xs}"><xs:simpleType name="L"><xs:list itemType="xs:int"/></xs:simpleType><xs:simpleType name="U"><xs:union memberTypes="xs:boolean L"/></xs:simpleType><xs:element name="root" type="U"/></xs:schema>`;
    const compiled = await compileXercesSchema(xsd, {
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
      const end = events.find((e) => e.kind === "endElement");
      assert.deepEqual(end.psvi.type.derivations, [
        true,
        ...Array(15).fill(false),
      ]);
      assert.equal(end.psvi.memberType.name, "L");
      assert.equal(end.psvi.memberType.derivations[8], true);
      assert.equal(events.at(-1).result.valid, true);
    } finally {
      compiled.dispose();
    }
  },
);
test(
  "Xerces isolates compile callbacks and preserves original byte budgets after decoding",
  { timeout: 20000 },
  async () => {
    const signal = { aborted: false };
    let observed = 0;
    const compiled = await compileXercesSchema(
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
      await assert.rejects(
        compiled.validate("<root/>", { maxBytes: 301 }),
        (e) => e.code === "INVALID_ARGUMENT",
      );
    } finally {
      compiled.dispose();
    }
  },
);
test(
  "Xerces corrects the recorded unadapted QName default namespace-context differential",
  { timeout: 20000 },
  async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/validation-qname-default.json", import.meta.url),
        "utf8",
      ),
    );
    const compiled = await compileXercesSchema(fixture.schema);
    try {
      const events = [];
      for await (const event of compiled.validateStream([fixture.xml]))
        events.push(event);
      assert.equal(
        events.at(-1).result.valid,
        fixture.observed.xmlweaveXercesAdapted.valid,
      );
      assert.equal(
        events
          .filter((e) => e.kind === "text")
          .map((e) => e.text)
          .join(""),
        fixture.observed.xerces4Unadapted.emittedText,
      );
      assert.equal(
        events.some((e) => e.kind === "startPrefixMapping" && e.prefix === "p"),
        false,
      );
      assert.equal(
        events.find((e) => e.kind === "endElement").psvi.schemaSpecified,
        true,
      );
      assert.match(
        events.find((e) => e.kind === "diagnostic").diagnostic.message,
        /instance namespace context/,
      );
      assert.equal(
        (await compiled.validate('<root xmlns:p="urn:default"/>')).valid,
        true,
      );
    } finally {
      compiled.dispose();
    }
  },
);
test(
  "Xerces QName-default context adaptation covers direct, attribute and list types without inventing bindings",
  { timeout: 20000 },
  async () => {
    const definitions = [
      `<xs:element name="root" type="xs:QName" default="p:Thing"/>`,
      `<xs:element name="root"><xs:complexType><xs:attribute name="q" type="xs:QName" default="p:Thing"/></xs:complexType></xs:element>`,
      `<xs:simpleType name="L"><xs:list itemType="xs:QName"/></xs:simpleType><xs:element name="root" type="L" default="p:One p:Two"/>`,
    ];
    for (const definition of definitions) {
      const compiled = await compileXercesSchema(
        `<xs:schema xmlns:xs="${xs}" xmlns:p="urn:default">${definition}</xs:schema>`,
      );
      try {
        assert.equal((await compiled.validate("<root/>")).valid, false);
        assert.equal(
          (await compiled.validate('<root xmlns:p="urn:default"/>')).valid,
          true,
        );
      } finally {
        compiled.dispose();
      }
    }
  },
);
const schema = `<xs:schema xmlns:xs="${xs}"><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="n" type="xs:int"/></xs:sequence><xs:attribute name="mode" type="xs:token" default="  hello   world "/><xs:attribute name="id" type="xs:ID"/></xs:complexType></xs:element></xs:schema>`;
test(
  "Xerces retains processing instructions and parser callback positions",
  { timeout: 20000 },
  async () => {
    const compiled = await compileXercesSchema(schema);
    try {
      const events = [];
      for await (const event of compiled.validateStream([
        "<?before hello?><root>\n<n>4</n>\n</root><?after bye?>",
      ]))
        events.push(event);
      assert.deepEqual(
        events
          .filter((e) => e.kind === "processingInstruction")
          .map((e) => [e.target, e.data]),
        [
          ["before", "hello"],
          ["after", "bye"],
        ],
      );
      const start = events.find(
        (e) => e.kind === "startElement" && e.name === "root",
      );
      const end = events.find(
        (e) => e.kind === "endElement" && e.name === "root",
      );
      assert.equal(start.generatedLocator.line, 1);
      assert.equal(end.generatedLocator.line, 3);
      assert.ok(start.generatedLocator.column > 0);
      assert.equal(events.at(-1).result.valid, true);
    } finally {
      compiled.dispose();
    }
  },
);
test(
  "Xerces stops native work on the first error and bounds collected datatype diagnostics",
  { timeout: 20000 },
  async () => {
    const compiled = await compileXercesSchema(schema);
    let advanced = false,
      closed = false;
    async function* input() {
      try {
        yield "<root><bad/>";
        advanced = true;
        yield "</root>";
      } finally {
        closed = true;
      }
    }
    await assert.rejects(
      (async () => {
        for await (const event of compiled.validateStream(input(), {
          errorPolicy: "throw",
        })) {
        }
      })(),
      (error) => error.code === "INVALID_XML",
    );
    assert.equal(advanced, false);
    assert.equal(closed, true);
    assert.equal(compiled.disposed, true);
    const collecting = await compileXercesSchema(schema);
    try {
      const result = await collecting.validate(
        '<root id="1bad"><n>bad</n></root>',
        { maxDiagnostics: 1 },
      );
      assert.equal(result.valid, false);
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnosticsTruncated, true);
    } finally {
      collecting.dispose();
    }
  },
);
test(
  "Xerces orders native default text after element metadata and retains diagnostic provenance",
  { timeout: 20000 },
  async () => {
    const xsd = `<xs:schema xmlns:xs="${xs}"><xs:element name="root" type="xs:token" default="  hello   world "/></xs:schema>`;
    const compiled = await compileXercesSchema(xsd);
    try {
      const events = [];
      for await (const event of compiled.validateStream(["<root/>"]))
        events.push(event);
      assert.deepEqual(
        events.map((e) => e.kind),
        [
          "startDocument",
          "startElement",
          "text",
          "endElement",
          "endDocument",
          "result",
        ],
      );
      assert.equal(events[2].text, "hello world");
      assert.equal(events[1].psvi.schemaSpecified, true);
      assert.equal(events[1].psvi.type.primitiveType.name, "string");
      const malformed = await compiled.validate({
        kind: "text",
        text: "<root>",
        systemId: "https://example.test/source.xml",
      });
      assert.equal(malformed.valid, false);
      assert.equal(malformed.diagnostics[0].phase, "parse");
      assert.equal(malformed.diagnostics[0].sourceKind, "text");
      assert.equal(malformed.diagnostics[0].provenance, "original");
      assert.equal(
        malformed.diagnostics[0].systemId,
        "https://example.test/source.xml",
      );
    } finally {
      compiled.dispose();
    }
  },
);
test(
  "Xerces returns native PSVI types, schema attributes, union members, xsi:type and normalized values",
  { timeout: 20000 },
  async () => {
    const compiled = await compileXercesSchema(schema);
    try {
      const events = [];
      for await (const event of compiled.validateStream([
        '<root id="one"><n>4</n></root>',
      ]))
        events.push(event);
      assert.equal(events.at(-1).result.valid, true);
      const root = events.find((e) => e.kind === "startElement");
      assert.equal(
        root.attributes.find((a) => a.name === "mode").specified,
        false,
      );
      assert.equal(
        root.attributes.find((a) => a.name === "mode").value,
        "hello world",
      );
      assert.equal(root.attributes.find((a) => a.name === "id").isId, true);
      const n = events.find((e) => e.kind === "endElement" && e.name === "n");
      assert.equal(n.psvi.type.name, "int");
      assert.ok(Object.isFrozen(n.psvi));
      assert.equal(
        (await compiled.validate("<root><n>bad</n></root>")).valid,
        false,
      );
      assert.equal(
        (await compiled.validate("<root><n>5</n></root>")).valid,
        true,
      );
    } finally {
      compiled.dispose();
    }
  },
);
test(
  "Xerces incremental output and invalid child occur before EOF with bounded application acknowledgement",
  { timeout: 20000 },
  async () => {
    const compiled = await compileXercesSchema(schema);
    let release;
    const gate = new Promise((r) => (release = r));
    let eof = false,
      closed = false;
    async function* chunks() {
      try {
        yield "<root><bad/>";
        await gate;
        eof = true;
        yield "</root>";
      } finally {
        closed = true;
      }
    }
    try {
      let earlyDiagnostic = false;
      for await (const event of compiled.validateStream(chunks())) {
        if (event.kind === "diagnostic" && !earlyDiagnostic) {
          assert.equal(eof, false);
          earlyDiagnostic = true;
          release();
        }
      }
      assert.equal(earlyDiagnostic, true);
      assert.equal(closed, true);
    } finally {
      release();
      compiled.dispose();
    }
  },
);
test(
  "Xerces rejects DOCTYPE, unknown schema resources, and invalid base64 using actual engine rules",
  { timeout: 20000 },
  async () => {
    const b64 = `<xs:schema xmlns:xs="${xs}"><xs:element name="n" type="xs:base64Binary"/></xs:schema>`;
    const compiled = await compileXercesSchema(b64);
    try {
      assert.equal((await compiled.validate("<n>%%%</n>")).valid, false);
      assert.equal((await compiled.validate("<n>YQ==</n>")).valid, true);
      assert.equal(
        (await compiled.validate("<!DOCTYPE n><n>YQ==</n>")).valid,
        false,
      );
    } finally {
      compiled.dispose();
    }
    await assert.rejects(
      compileXercesSchema({
        kind: "text",
        systemId: "https://schemas.example/root.xsd",
        text: `<xs:schema xmlns:xs="${xs}"><xs:include schemaLocation="absent.xsd"/></xs:schema>`,
      }),
      (e) => e.code === "INVALID_SCHEMA",
    );
  },
);
test(
  "Xerces catalogue uses canonical base URIs and callback exceptions stop native validation",
  { timeout: 20000 },
  async () => {
    const root = {
      kind: "text",
      systemId: "https://schemas.example/root.xsd",
      text: `<xs:schema xmlns:xs="${xs}"><xs:include schemaLocation="part.xsd"/><xs:element name="n" type="T"/></xs:schema>`,
    };
    const part = {
      kind: "text",
      systemId: "https://schemas.example/part.xsd",
      text: `<xs:schema xmlns:xs="${xs}"><xs:simpleType name="T"><xs:restriction base="xs:int"/></xs:simpleType></xs:schema>`,
    };
    const compiled = await compileXercesSchema([root, part]);
    try {
      assert.equal((await compiled.validate("<n>4</n>")).valid, true);
      const stop = new Error("observer stop");
      await assert.rejects(
        compiled.validate("<n>bad</n>", {
          onDiagnostic() {
            throw stop;
          },
        }),
        (e) => e === stop,
      );
    } finally {
      compiled.dispose();
    }
  },
);

test(
  "Xerces actual XS type graph answers restriction, extension, list, union, anonymous and selected-type queries",
  { timeout: 20000 },
  async () => {
    const xsd = `<xs:schema xmlns:xs="${xs}"><xs:simpleType name="R"><xs:restriction base="xs:int"/></xs:simpleType><xs:simpleType name="L"><xs:list itemType="xs:int"/></xs:simpleType><xs:simpleType name="U"><xs:union memberTypes="xs:int xs:boolean"/></xs:simpleType><xs:complexType name="B"><xs:sequence/></xs:complexType><xs:complexType name="E"><xs:complexContent><xs:extension base="B"><xs:attribute name="a" type="xs:int"/></xs:extension></xs:complexContent></xs:complexType><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="r" type="R"/><xs:element name="l" type="L"/><xs:element name="u" type="U"/><xs:element name="e" type="E"/><xs:element name="dynamic" type="xs:anyType"/></xs:sequence></xs:complexType></xs:element></xs:schema>`;
    const typeQueries = [
      { namespaceURI: xs, name: "decimal", method: 1 },
      { namespaceURI: xs, name: "int", method: 8 },
      { namespaceURI: xs, name: "int", method: 4 },
      { namespaceURI: "", name: "B", method: 2 },
      { namespaceURI: "", name: "B", method: 1 },
      { namespaceURI: xs, name: "decimal", method: 0 },
    ];
    const compiled = await compileXercesSchema(xsd, { typeQueries });
    try {
      const events = [];
      for await (const e of compiled.validateStream([
        `<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="${xs}"><r>1</r><l>1 2</l><u>true</u><e/><dynamic xsi:type="xs:int">7</dynamic></root>`,
      ]))
        events.push(e);
      assert.equal(events.at(-1).result.valid, true);
      const end = (name) =>
        events.find((e) => e.kind === "endElement" && e.name === name);
      assert.equal(end("r").psvi.type.derivations[0], true);
      assert.equal(end("l").psvi.type.derivations[1], true);
      assert.equal(end("l").psvi.type.derivations[5], true);
      assert.equal(end("u").psvi.type.derivations[2], true);
      assert.equal(end("u").psvi.memberType.name, "boolean");
      assert.equal(end("e").psvi.type.derivations[3], true);
      assert.equal(end("e").psvi.type.derivations[4], false);
      assert.equal(end("dynamic").psvi.type.name, "int");
      assert.equal(end("root").psvi.type.anonymous, true);
    } finally {
      compiled.dispose();
    }
  },
);
test(
  "Xerces complete DOM method-mask table follows named native XS graph rather than JDK implementation defects",
  { timeout: 20000 },
  async () => {
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
    const queries = targets.flatMap(([name, namespaceURI]) =>
      Array.from({ length: 16 }, (_, method) => ({
        name,
        namespaceURI,
        method,
      })),
    );
    // Each entry is the independent DOM relationship set: restriction=1,
    // extension=2, union=4, list=8. A zero entry has no relationship, including method zero.
    const expected = {
      r: [1, 1, 1, 1, 0, 1, 0, 0, 0, 0],
      l: [9, 9, 8, 8, 0, 8, 1, 0, 0, 0],
      u: [5, 5, 4, 4, 4, 4, 0, 1, 0, 0],
      b: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0],
      e: [2, 0, 0, 0, 0, 0, 0, 0, 2, 1],
      root: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    const compiled = await compileXercesSchema(xsd, { typeQueries: queries });
    try {
      let comparisons = 0;
      for await (const event of compiled.validateStream([
        "<root><r>1</r><l>1 2</l><u>true</u><b/><e/></root>",
      ]))
        if (event.kind === "endElement") {
          const relationships = expected[event.name];
          assert.ok(relationships);
          for (let target = 0; target < targets.length; target++)
            for (let method = 0; method < 16; method++) {
              const bits = relationships[target];
              assert.equal(
                event.psvi.type.derivations[target * 16 + method],
                method === 0 ? bits !== 0 : (bits & method) !== 0,
                `${event.name} -> ${targets[target][0]} method ${method}`,
              );
              comparisons++;
            }
          if (event.name === "u") {
            assert.equal(event.psvi.memberType.name, "boolean");
            assert.notDeepEqual(
              event.psvi.memberType.derivations,
              event.psvi.type.derivations,
            );
          }
        }
      assert.equal(comparisons, 960);
    } finally {
      compiled.dispose();
    }
  },
);
test(
  "Xerces identity-constraint errors remain provisional until final keyref resolution",
  { timeout: 20000 },
  async () => {
    const xsd = `<xs:schema xmlns:xs="${xs}"><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="item" minOccurs="0" maxOccurs="unbounded"><xs:complexType><xs:attribute name="id" type="xs:int"/></xs:complexType></xs:element><xs:element name="ref"><xs:complexType><xs:attribute name="id" type="xs:int"/></xs:complexType></xs:element></xs:sequence></xs:complexType><xs:key name="k"><xs:selector xpath="item"/><xs:field xpath="@id"/></xs:key><xs:keyref name="r" refer="k"><xs:selector xpath="ref"/><xs:field xpath="@id"/></xs:keyref></xs:element></xs:schema>`;
    const compiled = await compileXercesSchema(xsd);
    try {
      const events = [];
      for await (const e of compiled.validateStream([
        '<root><item id="1"/><ref id="2"/>',
        "</root>",
      ]))
        events.push(e);
      assert.equal(events.at(-1).result.valid, false);
      assert.ok(
        events.some((e) => e.kind === "endElement" && e.name === "ref"),
      );
      assert.ok(events.some((e) => e.kind === "diagnostic"));
    } finally {
      compiled.dispose();
    }
  },
);

test(
  "anonymous type identities remain stable and support retained graph queries",
  { timeout: 20000 },
  async () => {
    const schema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r"><xs:complexType><xs:sequence><xs:element name="a"><xs:simpleType><xs:restriction base="xs:int"/></xs:simpleType></xs:element><xs:element name="b"><xs:simpleType><xs:restriction base="xs:int"/></xs:simpleType></xs:element></xs:sequence></xs:complexType></xs:element></xs:schema>`;
    const compiled = await compileXercesSchema(schema);
    const other = await compileXercesSchema(schema);
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
    const compiled = await compileXercesSchema([
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
  "raw Xerces rejects awaitable diagnostic handlers with explicit capability error",
  { timeout: 20000 },
  async () => {
    const compiled = await compileXercesSchema(
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r" type="xs:int"/></xs:schema>',
    );
    try {
      await assert.rejects(
        compiled.validate("<r>bad</r>", { diagnosticHandler: async () => {} }),
        (error) => error.code === "UNSUPPORTED_CAPABILITY",
      );
    } finally {
      compiled.dispose();
    }
  },
);

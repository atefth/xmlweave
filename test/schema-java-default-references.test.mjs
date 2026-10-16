import test from "node:test";
import assert from "node:assert/strict";
import { compileJavaSchema } from "../dist/schema-java.js";

const xs = "http://www.w3.org/2001/XMLSchema";
const schema = (type, value, mode = "default") => `<xs:schema xmlns:xs="${xs}">
  <xs:simpleType name="Id"><xs:restriction base="xs:ID"/></xs:simpleType>
  <xs:simpleType name="Ref"><xs:restriction base="xs:IDREF"/></xs:simpleType>
  <xs:simpleType name="Refs"><xs:restriction base="xs:IDREFS"/></xs:simpleType>
  <xs:simpleType name="RefUnion"><xs:union memberTypes="xs:integer Ref"/></xs:simpleType>
  <xs:simpleType name="TextUnion"><xs:union memberTypes="xs:string Ref"/></xs:simpleType>
  <xs:simpleType name="RefList"><xs:list itemType="Ref"/></xs:simpleType>
  <xs:complexType name="IdContent"><xs:simpleContent><xs:extension base="Id"/></xs:simpleContent></xs:complexType>
  <xs:element name="root"><xs:complexType>
    <xs:sequence><xs:element name="target" type="IdContent" minOccurs="0" maxOccurs="unbounded"/></xs:sequence>
    <xs:attribute name="id" type="Id"/>
    <xs:attribute name="refs" type="${type}" ${mode}="${value}"/>
  </xs:complexType></xs:element>
</xs:schema>`;

for (const [type, value, mode] of [
  ["xs:IDREF", "abc", "default"],
  ["xs:IDREFS", "abc def", "default"],
  ["xs:IDREFS", "abc def", "fixed"],
  ["Ref", "abc", "default"],
  ["Refs", "abc def", "default"],
  ["RefUnion", "abc", "default"],
  ["RefList", "abc def", "default"],
]) {
  test(`Java checks schema-added ${type} ${mode} references across each episode`, async () => {
    const grammar = await compileJavaSchema(schema(type, value, mode));
    try {
      const source = {
        kind: "text",
        systemId: "urn:default-reference:instance",
        text: '<?xml version="1.0"?>\n<root/>',
      };
      const invalid = await grammar.validate(source);
      assert.equal(invalid.valid, false);
      assert.ok(invalid.diagnostics.some((d) => d.message.includes("abc")));
      assert.ok(invalid.diagnostics.every((d) => d.phase === "validate" && d.systemId === source.systemId && d.line === 2));
      assert.equal((await grammar.validate('<root id="abc"><target> def </target></root>')).valid, true);
      if (mode === "default")
        assert.equal((await grammar.validate('<root id="override" refs="override"/>')).valid, true, "a supplied value replaces the unused default");
      assert.equal((await grammar.validate("<root/>")).valid, false, "previous IDs must not leak into another episode");
      const output = await grammar.validateOutput("<root/>");
      assert.equal(output.result.valid, false);
      assert.equal(output.xml, undefined);
      assert.equal(output.document, undefined);
    } finally {
      grammar.dispose();
    }
  });
}

test("Java uses the actual selected union member for default reference checks", async () => {
  const grammar = await compileJavaSchema(schema("TextUnion", "abc"));
  try {
    assert.equal((await grammar.validate("<root/>")).valid, true);
  } finally {
    grammar.dispose();
  }
});

for (const type of ["IDREF", "IDREFS"]) {
  test(`Java already checks schema-default element ${type} values`, async () => {
    const grammar = await compileJavaSchema(`<xs:schema xmlns:xs="${xs}"><xs:element name="r"><xs:complexType><xs:sequence><xs:element name="ref" type="xs:${type}" default="abc"/><xs:element name="target" type="xs:ID" minOccurs="0"/></xs:sequence></xs:complexType></xs:element></xs:schema>`);
    try {
      assert.equal((await grammar.validate("<r><ref/></r>")).valid, false);
      assert.equal((await grammar.validate("<r><ref/><target>abc</target></r>")).valid, true);
    } finally {
      grammar.dispose();
    }
  });
}

test("default-reference diagnostics preserve streaming order and exact handler decisions", async () => {
  let grammar = await compileJavaSchema(schema("xs:IDREFS", "abc def"));
  try {
    const handled = [], events = [];
    for await (const event of grammar.validateStream(["<root", "/>"], {
      maxDiagnostics: 1,
      diagnosticHandler: async (diagnostic) => { handled.push(diagnostic); },
    })) events.push(event);
    assert.equal(handled.length, 2);
    assert.ok(events.findIndex((event) => event.kind === "diagnostic") < events.findIndex((event) => event.kind === "endDocument"));
    assert.equal(events.at(-1).result.valid, false);
    assert.equal(events.at(-1).result.diagnosticsTruncated, true);
    assert.equal((await grammar.validate("<root>")).valid, false);
  } finally {
    grammar.dispose();
  }
  grammar = await compileJavaSchema(schema("xs:IDREF", "abc"));
  try {
    const sentinel = { stop: "default-reference" };
    await assert.rejects(grammar.validate("<root/>", {
      diagnosticHandler() { throw sentinel; },
    }), (error) => error === sentinel);
    assert.equal(grammar.disposed, true);
  } finally {
    grammar.dispose();
  }
  grammar = await compileJavaSchema(schema("xs:IDREF", "abc"));
  try {
    await assert.rejects(grammar.validate("<root/>", {
      timeoutMs: 100,
      diagnosticHandler() { return new Promise(() => {}); },
    }), { code: "TIMEOUT" });
    assert.equal(grammar.disposed, true);
  } finally {
    grammar.dispose();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSchemaSource, compileSchema } from "../dist/schema.js";
import { parseXml, serializeXml } from "../dist/index.js";
const enc = new TextEncoder();
test("byte decoding detects UTF8 and UTF16, validates declaration conflicts and fatal input", async () => {
  for (const text of [
    "<r>é</r>",
    '<?xml version="1.0" encoding="UTF-8"?><r>😀</r>',
  ])
    assert.equal(
      (await normalizeSchemaSource({ kind: "bytes", bytes: enc.encode(text) }))
        .text,
      text,
    );
  const text = '<?xml version="1.0" encoding="UTF-16"?><r>é</r>';
  const le = Buffer.from(text, "utf16le");
  assert.equal(
    (
      await normalizeSchemaSource({
        kind: "bytes",
        bytes: Buffer.concat([Buffer.from([255, 254]), le]),
      })
    ).text,
    text,
  );
  const be = Buffer.from(le);
  be.swap16();
  assert.equal(
    (
      await normalizeSchemaSource({
        kind: "bytes",
        bytes: Buffer.concat([Buffer.from([254, 255]), be]),
      })
    ).text,
    text,
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: new Uint8Array([0xc3, 0x28]),
    }),
    { code: "INVALID_XML" },
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: Buffer.concat([Buffer.from([255, 254]), le]),
      encoding: "utf-8",
    }),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: enc.encode('<?xml version="1.0" encoding="UTF-16"?><r/>'),
      encoding: "utf-8",
    }),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: enc.encode("<r/>"),
      encoding: "invented",
    }),
    { code: "UNSUPPORTED_ENCODING" },
  );
  const latin = await normalizeSchemaSource({
    kind: "bytes",
    bytes: Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1"?><r>é</r>',
      "latin1",
    ),
  });
  assert.match(latin.text, /é/);
  const controls = await normalizeSchemaSource({
    kind: "bytes",
    bytes: new Uint8Array([0x80, 0x91, 0x9f]),
    encoding: "ISO-8859-1",
  });
  assert.deepEqual(
    [...controls.text].map((c) => c.codePointAt(0)),
    [0x80, 0x91, 0x9f],
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: new Uint8Array([0x80]),
      encoding: "US-ASCII",
    }),
    { code: "INVALID_XML" },
  );
  const longDeclaration =
    '<?xml version="1.0"' +
    " ".repeat(1100) +
    'encoding="ISO-8859-1"?><r>é</r>';
  assert.equal(
    (
      await normalizeSchemaSource({
        kind: "bytes",
        bytes: Buffer.from(longDeclaration, "latin1"),
      })
    ).text,
    longDeclaration,
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: new Uint8Array([0, 0, 0, 32, 0, 0, 0, 60]),
      encoding: "utf-32banana",
    }),
    { code: "UNSUPPORTED_ENCODING" },
  );
});
test("UTF32 byte-order detection, supplementary scalars and invalid input are strict", async () => {
  const text = '<?xml version="1.0" encoding="UTF-32"?><r>😀é</r>';
  function encoded(value, little, bom = true) {
    const points = [...((bom ? "\ufeff" : "") + value)].map((c) =>
      c.codePointAt(0),
    );
    const bytes = new Uint8Array(points.length * 4);
    const view = new DataView(bytes.buffer);
    points.forEach((point, i) => view.setUint32(i * 4, point, little));
    return bytes;
  }
  for (const little of [false, true])
    for (const bom of [false, true])
      assert.equal(
        (
          await normalizeSchemaSource({
            kind: "bytes",
            bytes: encoded(text, little, bom),
          })
        ).text,
        text,
      );
  const invalid = new Uint8Array([0, 0, 0xd8, 0]);
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: invalid,
      encoding: "utf-32be",
    }),
    { code: "INVALID_XML" },
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: new Uint8Array([0, 0x11, 0, 0]),
      encoding: "utf-32be",
    }),
    { code: "INVALID_XML" },
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: new Uint8Array([0, 0, 0]),
      encoding: "utf-32be",
    }),
    { code: "INVALID_XML" },
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: encoded(text, true),
      encoding: "utf-32be",
    }),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    normalizeSchemaSource({
      kind: "bytes",
      bytes: encoded('<?xml version="1.0" encoding="UTF-16"?><r/>', true),
    }),
    { code: "INVALID_ARGUMENT" },
  );
});
test("bounded chunks preserve split bytes and close iterator on limit, abort and mixed kind", async () => {
  const bytes = enc.encode("<r>😀</r>");
  const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
  assert.equal(
    (await normalizeSchemaSource({ kind: "chunks", chunks })).text,
    "<r>😀</r>",
  );
  for (const scenario of ["limit", "abort", "mixed"]) {
    let closed = false;
    const signal = { aborted: false };
    async function* source() {
      try {
        yield "first";
        if (scenario === "abort") signal.aborted = true;
        yield scenario === "mixed" ? new Uint8Array([1]) : "second";
        yield "never";
      } finally {
        closed = true;
      }
    }
    await assert.rejects(
      normalizeSchemaSource(
        { kind: "chunks", chunks: source() },
        { signal, maxCharacters: scenario === "limit" ? 3 : 100 },
      ),
      {
        code:
          scenario === "limit"
            ? "RESOURCE_LIMIT"
            : scenario === "abort"
              ? "ABORTED"
              : "INVALID_ARGUMENT",
      },
    );
    assert.equal(closed, true);
  }
});
test("DOM subtree copies inherited QName namespaces and base without mutating source", async () => {
  const doc = parseXml(
    '<a xmlns:t="urn:types" xml:base="https://example.test/base/"><b xml:base="nested/"><r xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="t:T">t:T</r></b></a>',
  );
  const before = serializeXml(doc);
  const subtree = doc.documentElement.firstElementChild.firstElementChild;
  const normalized = await normalizeSchemaSource({
    kind: "dom",
    node: subtree,
  });
  assert.equal(normalized.provenance, "generated");
  const root = parseXml(normalized.text).documentElement;
  assert.equal(root.lookupNamespaceURI("t"), "urn:types");
  assert.equal(
    root.getAttributeNS("http://www.w3.org/XML/1998/namespace", "base"),
    "https://example.test/base/nested/",
  );
  assert.equal(serializeXml(doc), before);
  await assert.rejects(
    normalizeSchemaSource({ kind: "dom", node: doc.createTextNode("x") }),
    { code: "INVALID_ARGUMENT" },
  );
  const relative = parseXml(
    '<a xml:base="folder/"><b xml:base="nested/"><r/></b></a>',
  );
  const resolved = await normalizeSchemaSource({
    kind: "dom",
    node: relative.documentElement.firstElementChild.firstElementChild,
    systemId: "https://example.test/root.xml",
  });
  assert.equal(
    parseXml(resolved.text).documentElement.getAttributeNS(
      "http://www.w3.org/XML/1998/namespace",
      "base",
    ),
    "https://example.test/folder/nested/",
  );
  const grammar = await compileSchema(
    '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r" type="xs:QName"/></xs:schema>',
  );
  try {
    const parent = parseXml('<a xmlns:t="urn:types"><r>t:T</r></a>');
    assert.equal(
      (
        await grammar.validate({
          kind: "dom",
          node: parent.documentElement.firstElementChild,
        })
      ).valid,
      true,
    );
    assert.equal((await grammar.validate("<r>t:T</r>")).valid, false);
  } finally {
    grammar.dispose();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  compileSchema,
  SchemaError,
  normalizeSchemaSource,
  schemaCapabilities,
} from "../dist/schema.js";
const xsd =
  '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="n" type="xs:positiveInteger"/></xs:schema>';
test("original source diagnostics retain line and identity and decoded text is UTF-8", async () => {
  const grammar = await compileSchema(xsd);
  try {
    const result = await grammar.validate({
      kind: "text",
      text: '<?xml version="1.0" encoding="ISO-8859-1"?>\r\n<n>é</n>',
      systemId: "https://example.test/input.xml",
    });
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0].line, 2);
    assert.equal(
      result.diagnostics[0].systemId,
      "https://example.test/input.xml",
    );
    assert.equal(result.diagnostics[0].provenance, "original");
    assert.match(result.diagnostics[0].message, /é/);
    await assert.rejects(
      grammar.validate({
        kind: "text",
        text: '<?xml version="1.0"?>\n<!DOCTYPE n><n/>',
        systemId: "urn:broken",
      }),
      (e) =>
        e.code === "INVALID_XML" &&
        e.diagnostics[0].line === 2 &&
        e.diagnostics[0].systemId === "urn:broken" &&
        e.diagnostics[0].phase === "parse",
    );
  } finally {
    grammar.dispose();
  }
});
test("independent sessions reject busy mutations and recover from callback exceptions", async () => {
  const grammar = await compileSchema(xsd);
  let session;
  const sentinel = new Error("observer");
  session = grammar.createValidator({
    onDiagnostic() {
      assert.throws(() => session.reset(), { code: "BUSY" });
      assert.throws(() => grammar.dispose(), { code: "BUSY" });
      throw sentinel;
    },
  });
  const other = grammar.createValidator();
  try {
    const pending = session.validate("<n>bad</n>");
    await assert.rejects(session.validate("<n>1</n>"), { code: "BUSY" });
    await assert.rejects(pending, (e) => e === sentinel);
    assert.equal(session.busy, false);
    assert.equal((await other.validate("<n>2</n>")).valid, true);
    session.reset();
    assert.equal((await session.validate("<n>3</n>")).valid, true);
    await assert.rejects(
      other.validate("<n>bad</n>", { errorPolicy: "throw" }),
      (e) => e instanceof SchemaError && e.code === "INVALID_XML",
    );
    assert.equal(
      (await other.validate("<n>bad</n>")).valid,
      false,
      "override does not mutate defaults",
    );
  } finally {
    grammar.dispose();
  }
  assert.equal(session.disposed, true);
  await assert.rejects(session.validate("<n>2</n>"), { code: "DISPOSED" });
});
test("strict options, bounded diagnostics, and truthful capabilities", async () => {
  await assert.rejects(compileSchema(xsd, { maxDiagnostics: 0 }), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(compileSchema(xsd, { imaginary: true }), {
    code: "INVALID_ARGUMENT",
  });
  const grammar = await compileSchema(
    '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r"><s:complexType><s:sequence><s:element name="n" type="s:int" maxOccurs="unbounded"/></s:sequence></s:complexType></s:element></s:schema>',
  );
  try {
    const seen = [];
    const result = await grammar.validate("<r><n>x</n><n>y</n></r>", {
      maxDiagnostics: 1,
      onDiagnostic: (d) => seen.push(d),
    });
    assert.equal(seen.length, 1);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnosticsTruncated, true);
    assert.equal(Object.isFrozen(seen[0]), true);
  } finally {
    grammar.dispose();
  }
  assert.equal(schemaCapabilities.immediateErrorHandler, false);
  assert.equal(schemaCapabilities.incrementalValidation, false);
});
test("factory processing limits are immutable inherited ceilings without inheriting callbacks or signal", async () => {
  const signal = { aborted: false };
  let called = 0;
  const options = {
    maxCharacters: 300,
    maxBytes: 400,
    maxDiagnostics: 2,
    signal,
    onDiagnostic() {
      called++;
    },
    errorPolicy: "throw",
  };
  const grammar = await compileSchema(xsd, options);
  options.maxCharacters = 1000;
  signal.aborted = true;
  try {
    assert.equal((await grammar.validate("<n>bad</n>")).valid, false);
    assert.equal(called, 0);
    assert.throws(() => grammar.createValidator({ maxCharacters: 301 }), {
      code: "INVALID_ARGUMENT",
    });
    await assert.rejects(grammar.validate("<n>" + "1".repeat(300) + "</n>"), {
      code: "RESOURCE_LIMIT",
    });
    await assert.rejects(grammar.validate("<n>1</n>", { maxBytes: 401 }), {
      code: "INVALID_ARGUMENT",
    });
    const session = grammar.createValidator({ maxCharacters: 100 });
    await assert.rejects(session.validate("<n>1</n>", { maxDiagnostics: 3 }), {
      code: "INVALID_ARGUMENT",
    });
    assert.equal((await session.validate("<n>1</n>")).valid, true);
    session.dispose();
  } finally {
    grammar.dispose();
  }
});

test("original byte limit is not reinterpreted as the UTF8 transport limit", async () => {
  const grammar = await compileSchema(
    '<s:schema xmlns:s="http://www.w3.org/2001/XMLSchema"><s:element name="r" type="s:string"/></s:schema>',
    { maxBytes: 30 },
  );
  try {
    assert.equal(
      (
        await grammar.validate({
          kind: "bytes",
          encoding: "ISO-8859-1",
          bytes: Buffer.from("<r>" + "é".repeat(20) + "</r>", "latin1"),
        })
      ).valid,
      true,
    );
  } finally {
    grammar.dispose();
  }
});
test("shared native grammar bounds active and queued validation episodes", async () => {
  const grammar = await compileSchema(xsd);
  let release;
  const gate = new Promise((r) => (release = r));
  async function* stalled() {
    await gate;
    yield "<n>1</n>";
  }
  const pending = Array.from({ length: 32 }, () =>
    grammar.validate({ kind: "chunks", chunks: stalled() }),
  );
  try {
    await assert.rejects(grammar.validate("<n>1</n>"), {
      code: "RESOURCE_LIMIT",
    });
    release();
    assert.ok((await Promise.all(pending)).every((result) => result.valid));
  } finally {
    release();
    await Promise.allSettled(pending);
    grammar.dispose();
  }
});

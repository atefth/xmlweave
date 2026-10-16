import test from "node:test";
import assert from "node:assert/strict";
import {
  compileSchema,
  loadSchemaEngine,
  SchemaError,
} from "../dist/schema.js";
import {
  xmlRegisterInputProvider,
  xmlCleanupInputProvider,
} from "libxml2-wasm";

const ns = "http://www.w3.org/2001/XMLSchema";
const schema = `<xs:schema xmlns:xs="${ns}"><xs:element name="count" type="xs:positiveInteger"/></xs:schema>`;
test("async engine load, reusable XSD validator, structured diagnostics and deterministic disposal", async () => {
  await loadSchemaEngine();
  try {
    const compiled = await compileSchema(schema);
    assert.equal(compiled.disposed, false);
    const session = compiled.createValidator();
    assert.equal(session.disposed, false);
    assert.deepEqual(await compiled.validate("<count>4</count>"), {
      valid: true,
      diagnostics: [],
    });
    const invalid = await compiled.validate("<count>-2</count>");
    assert.equal(invalid.valid, false);
    assert.ok(invalid.diagnostics.length > 0);
    assert.equal(invalid.diagnostics[0].severity, "error");
    assert.ok(invalid.diagnostics[0].message.length > 0);
    assert.equal(invalid.diagnostics[0].line, 1);
    await assert.rejects(compiled.validate("<count>"), { code: "INVALID_XML" });
    assert.equal((await compiled.validate("<count>6</count>")).valid, true);
    compiled.dispose();
    compiled.dispose();
    assert.equal(compiled.disposed, true);
    await assert.rejects(compiled.validate("<count>1</count>"), {
      code: "DISPOSED",
    });
    assert.equal(session.disposed, true);
    await assert.rejects(session.validate("<count>1</count>"), {
      code: "DISPOSED",
    });
  } finally {
  }
});

test("reject schemas and XML requiring external resources before entering WASM", async () => {
  const rejected = [];
  const provider = {
    match: () => true,
    open: (url) => {
      rejected.push(url);
      throw new Error("must not resolve");
    },
    read: () => 0,
    close: () => {},
  };
  xmlRegisterInputProvider(provider);
  try {
    for (const kind of ["include", "import", "redefine", "override"]) {
      for (const location of [
        "file:///etc/passwd",
        "https://example.invalid/schema.xsd",
        "./relative.xsd",
      ]) {
        await assert.rejects(
          compileSchema(
            `<s:schema xmlns:s="${ns}"><s:${kind} schemaLocation="${location}"/></s:schema>`,
          ),
          { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
        );
      }
    }
    await assert.rejects(
      compileSchema(
        `<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><xs:schema xmlns:xs="${ns}"/>`,
      ),
      { code: "INVALID_SCHEMA" },
    );
    await assert.rejects(
      compileSchema(
        `<s:schema xmlns:s="${ns}" xmlns:i="http://www.w3.org/2001/XInclude"><i:include href="file:///etc/passwd"/></s:schema>`,
      ),
      { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
    );
    const compiled = await compileSchema(schema);
    try {
      await assert.rejects(
        compiled.validate(
          '<count xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://example.invalid/a.xsd">2</count>',
        ),
        { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
      );
      await assert.rejects(
        compiled.validate(
          '<!DOCTYPE count SYSTEM "file:///etc/passwd"><count>2</count>',
        ),
        { code: "INVALID_XML" },
      );
    } finally {
      compiled.dispose();
    }
    assert.deepEqual(rejected, [], "input provider was never consulted");
  } finally {
    xmlCleanupInputProvider();
  }
});

test("XML-aware preflight ignores misleading comments and rejects decoded namespace aliases", async () => {
  const compiled = await compileSchema(
    schema.replace(
      "<xs:element",
      '<!-- <xs:include schemaLocation="evil"/> --><xs:element',
    ),
  );
  compiled.dispose();
  await assert.rejects(
    compileSchema(
      `<s:schema xmlns:s="http://www.w3.org/2001/XMLSch&#101;ma"><s:include schemaLocation="evil"/></s:schema>`,
    ),
    { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
  );
  await assert.rejects(compileSchema("<notSchema/>"), {
    code: "INVALID_SCHEMA",
  });
  await assert.rejects(
    compileSchema(
      `<s:schema xmlns:s="${ns}"><s:assert test="true()"/></s:schema>`,
    ),
    { code: "INVALID_SCHEMA" },
  );
});

test("failure, already-aborted requests and repeated cycles close default native handles", async () => {
  const start = process.memoryUsage();
  try {
    await assert.rejects(loadSchemaEngine({ signal: { aborted: true } }), {
      code: "ABORTED",
    });
    await assert.rejects(compileSchema(schema, { signal: { aborted: true } }), {
      code: "ABORTED",
    });
    const signal = { aborted: false };
    const initializing = loadSchemaEngine({ signal });
    signal.aborted = true;
    await assert.rejects(
      initializing,
      { code: "ABORTED" },
      "abort observed after asynchronous engine import",
    );
    for (let i = 0; i < 100; i++) {
      await assert.rejects(
        compileSchema(
          `<s:schema xmlns:s="${ns}"><s:element name="count" type="s:nonexistent"/></s:schema>`,
        ),
        (error) =>
          error instanceof SchemaError &&
          error.code === "INVALID_SCHEMA" &&
          error.diagnostics.length > 0,
      );
      const compiled = await compileSchema(schema);
      try {
        await assert.rejects(
          compiled.validate("<count>1</count>", { signal: { aborted: true } }),
          { code: "ABORTED" },
        );
        assert.equal((await compiled.validate("<count>1</count>")).valid, true);
        assert.equal(
          (await compiled.validate("<count>bad</count>")).valid,
          false,
        );
      } finally {
        compiled.dispose();
      }
    }
    // Public lifecycle checks do not claim visibility into native allocator internals.
    const end = process.memoryUsage();
    console.log(
      `schema lifecycle measurement: 100 cycles; rss delta ${end.rss - start.rss}; external delta ${end.external - start.external}; arrayBuffers delta ${end.arrayBuffers - start.arrayBuffers}; all public compiled/session handles disposed`,
    );
  } finally {
  }
});

test("default native engine rejects invalid base64 lexical values", async () => {
  const compiled = await compileSchema(
    `<s:schema xmlns:s="${ns}"><s:element name="value" type="s:base64Binary"/></s:schema>`,
  );
  try {
    assert.equal((await compiled.validate("<value>%%%</value>")).valid, false);
    assert.equal((await compiled.validate("<value>YQ==</value>")).valid, true);
  } finally {
    compiled.dispose();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  createHintValidator,
  readDynamicSchemaHints,
} from "../dist/schema-hints.js";
const xs = "http://www.w3.org/2001/XMLSchema",
  xsi = "http://www.w3.org/2001/XMLSchema-instance";
const schema = (type) =>
  `<s:schema xmlns:s="${xs}"><s:element name="r" type="s:${type}"/></s:schema>`;
const doc = (location, value = "3") => ({
  kind: "text",
  systemId: "https://app.test/document.xml",
  text: `<r xmlns:xsi="${xsi}" xsi:noNamespaceSchemaLocation="${location}">${value}</r>`,
});

test("rejected resolver resources do not consume the pinned catalogue budget", async () => {
  let compiled = 0;
  const small = schema("int");
  const large = small.replace(
    "</s:schema>",
    `<!--${"x".repeat(300)}--></s:schema>`,
  );
  const dynamic = await createHintValidator({
    maxGraphBytes: 200,
    resolver: (request) =>
      request.requestedURI.endsWith("large.xsd") ? large : small,
    compiler: async () => {
      compiled++;
      return {
        validate: async () => ({ valid: true, diagnostics: [] }),
        dispose() {},
      };
    },
  });
  try {
    await assert.rejects(dynamic.validate(doc("large.xsd")), {
      code: "RESOURCE_LIMIT",
    });
    assert.equal((await dynamic.validate(doc("small.xsd"))).valid, true);
    assert.equal(compiled, 1);
    assert.equal(dynamic.cacheSize, 1);
  } finally {
    dynamic.dispose();
  }
});

test("default hint handlers negotiate exact capability before catalogue or instance consumption", async () => {
  const original = globalThis.SharedArrayBuffer;
  let read = 0;
  const chunks = {
    async *[Symbol.asyncIterator]() {
      read++;
      yield "<r/>";
    },
  };
  const dynamic = await createHintValidator();
  try {
    globalThis.SharedArrayBuffer = undefined;
    await assert.rejects(
      createHintValidator({
        diagnosticHandler() {},
        resourceMap: { "https://app.test/one.xsd": { kind: "chunks", chunks } },
      }),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
    await assert.rejects(
      dynamic.validate({ kind: "chunks", chunks }, { diagnosticHandler() {} }),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
    assert.equal(read, 0);
  } finally {
    globalThis.SharedArrayBuffer = original;
    dynamic.dispose();
  }
});

test("hint operations cannot erase inherited limits with undefined or increase the deadline", async () => {
  const dynamic = await createHintValidator({
    resourceMap: { "https://app.test/one.xsd": schema("int") },
    maxBytes: 30,
    timeoutMs: 1000,
  });
  try {
    const bytes = new TextEncoder().encode(doc("one.xsd").text);
    await assert.rejects(
      dynamic.validate(
        { kind: "bytes", bytes, systemId: "https://app.test/document.xml" },
        { maxBytes: undefined },
      ),
      { code: "RESOURCE_LIMIT" },
    );
    await assert.rejects(
      dynamic.validate(doc("one.xsd"), { timeoutMs: 1001 }),
      { code: "INVALID_ARGUMENT" },
    );
    await assert.rejects(
      dynamic.validate(doc("one.xsd"), { signal: { aborted: "yes" } }),
      { code: "INVALID_ARGUMENT" },
    );
  } finally {
    dynamic.dispose();
  }
});
test(
  "dynamic native hints change schema per document, reuse URI identity and evict bounded grammars",
  { timeout: 30000 },
  async () => {
    const map = {
      "https://app.test/one.xsd": schema("int"),
      "https://app.test/two.xsd": schema("boolean"),
    };
    const dynamic = await createHintValidator({
      resourceMap: map,
      maxCachedSchemas: 1,
      timeoutMs: 10000,
    });
    map["https://app.test/one.xsd"] = schema("boolean");
    try {
      assert.equal((await dynamic.validate(doc("one.xsd", "3"))).valid, true);
      assert.equal(
        (await dynamic.validate(doc("two.xsd", "true"))).valid,
        true,
      );
      assert.equal((await dynamic.validate(doc("two.xsd", "3"))).valid, false);
      assert.equal(dynamic.cacheSize, 1);
      assert.equal((await dynamic.validate(doc("one.xsd", "3"))).valid, true);
      await assert.rejects(dynamic.validate(doc("denied.xsd")), {
        code: "EXTERNAL_RESOURCE_FORBIDDEN",
      });
      dynamic.clearCache();
      assert.equal(dynamic.cacheSize, 0);
    } finally {
      dynamic.dispose();
    }
    await assert.rejects(dynamic.validate(doc("one.xsd")), {
      code: "DISPOSED",
    });
  },
);
test(
  "root and descendant hints resolve inherited xml:base and compose approved namespaces",
  { timeout: 30000 },
  async () => {
    const root = `<s:schema xmlns:s="${xs}" xmlns:n="urn:n"><s:import namespace="urn:n"/><s:element name="r"><s:complexType><s:sequence><s:element ref="n:value"/></s:sequence></s:complexType></s:element></s:schema>`;
    const nested = `<s:schema xmlns:s="${xs}" targetNamespace="urn:n"><s:element name="value"><s:complexType><s:simpleContent><s:extension base="s:int"><s:anyAttribute namespace="http://www.w3.org/XML/1998/namespace" processContents="skip"/></s:extension></s:simpleContent></s:complexType></s:element></s:schema>`;
    const dynamic = await createHintValidator({
      resourceMap: {
        "https://app.test/root.xsd": root,
        "https://app.test/parts/nested.xsd": nested,
      },
      timeoutMs: 10000,
    });
    try {
      const input = {
        kind: "text",
        systemId: "https://app.test/input.xml",
        text: `<r xmlns:xsi="${xsi}" xmlns:n="urn:n" xsi:noNamespaceSchemaLocation="root.xsd"><n:value xml:base="parts/" xsi:schemaLocation="urn:n nested.xsd">5</n:value></r>`,
      };
      assert.equal((await dynamic.validate(input)).valid, true);
    } finally {
      dynamic.dispose();
    }
  },
);
test("hint syntax/conflicts and malformed XML fail before resolution", async () => {
  const bad = [
    `<r xmlns:xsi="${xsi}" xsi:schemaLocation="urn:missing"/>`,
    `<r xmlns:xsi="${xsi}" xsi:noNamespaceSchemaLocation="a.xsd"><r xsi:noNamespaceSchemaLocation="b.xsd"/></r>`,
    `<r xmlns:xsi="${xsi}" xsi:noNamespaceSchemaLocation="a.xsd b.xsd"/>`,
    "<r>",
    "<r/>",
  ];
  for (const xml of bad)
    assert.throws(() => readDynamicSchemaHints(xml), { code: "INVALID_XML" });
  const hints = readDynamicSchemaHints(
    `<r xmlns:xsi="${xsi}" xsi:noNamespaceSchemaLocation="a.xsd"><r xsi:noNamespaceSchemaLocation="./a.xsd"/></r>`,
    "https://app.test/input.xml",
  );
  assert.equal(hints.length, 1);
  assert.equal(hints[0].uri, "https://app.test/a.xsd");
});
test(
  "approved resolver responses are pinned; same-handle concurrency serializes",
  { timeout: 30000 },
  async () => {
    let resolves = 0,
      compiles = 0,
      active = 0,
      maximum = 0,
      disposals = 0;
    const dynamic = await createHintValidator({
      resolver: async () => {
        resolves++;
        return schema("int");
      },
      compiler: async () => {
        compiles++;
        return {
          async validate() {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((r) => setTimeout(r, 10));
            active--;
            return { valid: true, diagnostics: [] };
          },
          dispose() {
            disposals++;
          },
        };
      },
    });
    try {
      const results = await Promise.all([
        dynamic.validate(doc("same.xsd")),
        dynamic.validate(doc("same.xsd")),
      ]);
      assert.ok(results.every((r) => r.valid));
      assert.equal(resolves, 1);
      assert.equal(compiles, 1);
      assert.equal(maximum, 1);
    } finally {
      dynamic.dispose();
    }
    assert.equal(disposals, 1);
  },
);
test(
  "deadlines cover source/resolver waits, dispose closes in-flight handles, facade remains reusable",
  { timeout: 30000 },
  async () => {
    let closed = 0;
    const dynamic = await createHintValidator({
      resourceMap: { "https://app.test/one.xsd": schema("int") },
      timeoutMs: 10000,
      maxPendingValidations: 1,
    });
    try {
      const stalled = {
        kind: "chunks",
        chunks: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise(() => {}),
              return() {
                closed++;
                return Promise.resolve({ done: true });
              },
            };
          },
        },
      };
      await assert.rejects(dynamic.validate(stalled, { timeoutMs: 20 }), {
        code: "TIMEOUT",
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(closed, 1);
      assert.equal((await dynamic.validate(doc("one.xsd"))).valid, true);
    } finally {
      dynamic.dispose();
    }
    const resolver = await createHintValidator({
      resolver: () => new Promise(() => {}),
    });
    try {
      await assert.rejects(
        resolver.validate(doc("one.xsd"), { timeoutMs: 20 }),
        { code: "TIMEOUT" },
      );
    } finally {
      resolver.dispose();
    }
    let release,
      disposed = 0;
    const waiting = new Promise((r) => (release = r));
    const injected = await createHintValidator({
      resourceMap: { "https://app.test/one.xsd": schema("int") },
      compiler: async () => {
        await waiting;
        return {
          async validate() {
            return { valid: true, diagnostics: [] };
          },
          dispose() {
            disposed++;
          },
        };
      },
    });
    const pending = injected.validate(doc("one.xsd"));
    await new Promise((r) => setTimeout(r, 10));
    injected.dispose();
    await assert.rejects(pending, { code: "DISPOSED" });
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(disposed, 1);
  },
);

test(
  "active cache entries and pending validation are bounded without killing healthy unrelated work",
  { timeout: 30000 },
  async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let compiled = 0,
      disposed = 0;
    const dynamic = await createHintValidator({
      resourceMap: {
        "https://app.test/one.xsd": schema("int"),
        "https://app.test/two.xsd": schema("int"),
      },
      maxCachedSchemas: 1,
      maxPendingValidations: 2,
      compiler: async () => {
        compiled++;
        return {
          async validate() {
            if (compiled === 1) await gate;
            return { valid: true, diagnostics: [] };
          },
          dispose() {
            disposed++;
          },
        };
      },
    });
    try {
      const first = dynamic.validate(doc("one.xsd"));
      await new Promise((r) => setTimeout(r, 10));
      await assert.rejects(dynamic.validate(doc("two.xsd")), {
        code: "RESOURCE_LIMIT",
      });
      release();
      assert.equal((await first).valid, true);
      assert.equal((await dynamic.validate(doc("two.xsd"))).valid, true);
      assert.equal(compiled, 2);
      assert.equal(disposed, 1);
    } finally {
      release();
      dynamic.dispose();
    }
    const limited = await createHintValidator({ maxPendingValidations: 1 });
    const pending = limited.validate({
      kind: "chunks",
      chunks: {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise(() => {}),
            return: async () => ({ done: true }),
          };
        },
      },
    });
    await assert.rejects(limited.validate(doc("one.xsd")), {
      code: "RESOURCE_LIMIT",
    });
    limited.dispose();
    await assert.rejects(pending, { code: "DISPOSED" });
  },
);
test("unapproved descendant hints and namespace mismatch cannot reach compilation", async () => {
  let compiles = 0;
  const dynamic = await createHintValidator({
    resourceMap: { "https://app.test/one.xsd": schema("int") },
    compiler: async () => {
      compiles++;
      throw new Error("must not compile");
    },
  });
  try {
    await assert.rejects(
      dynamic.validate({
        kind: "text",
        systemId: "https://app.test/document.xml",
        text: `<r xmlns:xsi="${xsi}" xsi:noNamespaceSchemaLocation="one.xsd"><other xsi:schemaLocation="urn:other unknown.xsd"/></r>`,
      }),
      { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
    );
    await assert.rejects(
      dynamic.validate({
        kind: "text",
        systemId: "https://app.test/document.xml",
        text: `<r xmlns="urn:other" xmlns:xsi="${xsi}" xsi:schemaLocation="urn:other one.xsd"/>`,
      }),
      { code: "INVALID_SCHEMA" },
    );
    assert.equal(compiles, 0);
  } finally {
    dynamic.dispose();
  }
  await assert.rejects(createHintValidator({ features: { madeUp: true } }), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(createHintValidator({ maxCachedSchemas: 0 }), {
    code: "INVALID_ARGUMENT",
  });
});

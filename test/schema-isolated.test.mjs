import test from "node:test";
import assert from "node:assert/strict";
import { compileIsolatedSchema } from "../dist/schema-isolated.js";
const X = "http://www.w3.org/2001/XMLSchema";
const schema = (body) => `<xs:schema xmlns:xs="${X}">${body}</xs:schema>`;
const text = (text, systemId) => ({ kind: "text", text, systemId });
const id = "https://schemas.invalid/root.xsd";
const enumSchema = (value) =>
  schema(
    `<xs:simpleType name="Code"><xs:restriction base="xs:string"><xs:enumeration value="${value}"/></xs:restriction></xs:simpleType>`,
  );
const root = schema(
  '<xs:include schemaLocation="parts.xsd"/><xs:element name="r" type="Code"/>',
);
test("isolated composition uses relative IDs, async resolver metadata and original instance locations", async () => {
  const calls = [];
  const compiled = await compileIsolatedSchema(text(root, id), {
    resolver: async (request) => {
      calls.push(request);
      return text(enumSchema("OK"), "ignored-alias.xsd");
    },
  });
  try {
    assert.equal((await compiled.validate("<r>OK</r>")).valid, true);
    const result = await compiled.validate(
      text("\n<r>BAD</r>", "https://instance.invalid/a.xml"),
    );
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0].line, 2);
    assert.equal(
      result.diagnostics[0].systemId,
      "https://instance.invalid/a.xml",
    );
    assert.equal(calls[0].requestedURI, "https://schemas.invalid/parts.xsd");
    assert.equal(calls[0].kind, "include");
    assert.equal(Object.isFrozen(calls[0]), true);
  } finally {
    compiled.dispose();
  }
});
test("concurrent private workers with identical resource IDs never share providers", async () => {
  const [a, b] = await Promise.all(
    ["A", "B"].map((value) =>
      compileIsolatedSchema(text(root, id), {
        resourceMap: { "https://schemas.invalid/parts.xsd": enumSchema(value) },
      }),
    ),
  );
  try {
    assert.deepEqual(
      await Promise.all([a.validate("<r>A</r>"), b.validate("<r>A</r>")]).then(
        (r) => r.map((x) => x.valid),
      ),
      [true, false],
    );
  } finally {
    a.dispose();
    b.dispose();
  }
});
test("namespace-only import and same-namespace source sets use native component assembly", async () => {
  const a = text(
    `<xs:schema xmlns:xs="${X}" xmlns:b="urn:b"><xs:import namespace="urn:b"/><xs:element name="r" type="b:Code"/></xs:schema>`,
    id,
  );
  const b = text(
    `<xs:schema xmlns:xs="${X}" targetNamespace="urn:b"><xs:simpleType name="Code"><xs:restriction base="xs:integer"/></xs:simpleType></xs:schema>`,
    "https://schemas.invalid/b.xsd",
  );
  const c = await compileIsolatedSchema([a, b]);
  try {
    assert.equal((await c.validate("<r>1</r>")).valid, true);
    assert.equal((await c.validate("<r>x</r>")).valid, false);
  } finally {
    c.dispose();
  }
  const one = text(
      schema('<xs:element name="a" type="xs:string"/>'),
      "https://schemas.invalid/one.xsd",
    ),
    two = text(
      schema('<xs:element name="b" type="xs:integer"/>'),
      "https://schemas.invalid/two.xsd",
    );
  const set = await compileIsolatedSchema([one, two]);
  try {
    assert.equal((await set.validate("<a>x</a>")).valid, true);
    assert.equal((await set.validate("<b>2</b>")).valid, true);
  } finally {
    set.dispose();
  }
});
test("nested resources, chameleon includes, legitimate cycles and redefine", async () => {
  const resources = {
    "https://schemas.invalid/parts.xsd": schema(
      '<xs:include schemaLocation="nested/code.xsd"/>',
    ),
    "https://schemas.invalid/nested/code.xsd": schema(
      '<xs:include schemaLocation="../parts.xsd"/><xs:simpleType name="Code"><xs:restriction base="xs:string"/></xs:simpleType>',
    ),
  };
  const c = await compileIsolatedSchema(text(root, id), {
    resourceMap: resources,
  });
  try {
    assert.equal((await c.validate("<r>x</r>")).valid, true);
  } finally {
    c.dispose();
  }
  const redefine = schema(
    '<xs:redefine schemaLocation="parts.xsd"><xs:simpleType name="Code"><xs:restriction base="Code"><xs:maxLength value="2"/></xs:restriction></xs:simpleType></xs:redefine><xs:element name="r" type="Code"/>',
  );
  const d = await compileIsolatedSchema(text(redefine, id), {
    resourceMap: {
      "https://schemas.invalid/parts.xsd": schema(
        '<xs:simpleType name="Code"><xs:restriction base="xs:string"/></xs:simpleType>',
      ),
    },
  });
  try {
    assert.equal((await d.validate("<r>ok</r>")).valid, true);
    assert.equal((await d.validate("<r>bad</r>")).valid, false);
  } finally {
    d.dispose();
  }
});
test("deny unknown resources, namespace mismatch, malicious dependencies and exhausted graph budgets", async () => {
  await assert.rejects(compileIsolatedSchema(text(root, id)), {
    code: "EXTERNAL_RESOURCE_FORBIDDEN",
  });
  await assert.rejects(
    compileIsolatedSchema(text(root, id), {
      resourceMap: {
        "https://schemas.invalid/parts.xsd": `<!DOCTYPE schema><xs:schema xmlns:xs="${X}"/>`,
      },
    }),
    { code: "INVALID_SCHEMA" },
  );
  await assert.rejects(
    compileIsolatedSchema(text(root, id), {
      resourceMap: {
        "https://schemas.invalid/parts.xsd": `<xs:schema xmlns:xs="${X}" targetNamespace="urn:wrong"/>`,
      },
    }),
    { code: "INVALID_SCHEMA" },
  );
  await assert.rejects(
    compileIsolatedSchema(text(root, id), {
      resourceMap: { "https://schemas.invalid/parts.xsd": enumSchema("OK") },
      maxDocuments: 1,
    }),
    { code: "RESOURCE_LIMIT" },
  );
  await assert.rejects(
    compileIsolatedSchema(schema('<xs:import namespace="urn:unresolved"/>')),
    { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
  );
});
test("host libxml provider registrations survive private compile and teardown", async () => {
  const lib = await import("libxml2-wasm");
  const url = "https://host.invalid/only.xsd";
  const provider = new lib.XmlBufferInputProvider({
    [url]: new TextEncoder().encode(enumSchema("host")),
  });
  let opened = 0;
  lib.xmlRegisterInputProvider({
    match: (u) => u === url,
    open: (u) => {
      opened++;
      return provider.open(u);
    },
    read: (fd, b) => provider.read(fd, b),
    close: (fd) => provider.close(fd),
  });
  const c = await compileIsolatedSchema(
    schema('<xs:element name="r" type="xs:string"/>'),
  );
  c.dispose();
  let doc, validator;
  try {
    doc = lib.XmlDocument.fromString(
      schema(`<xs:include schemaLocation="${url}"/>`),
    );
    validator = lib.XsdValidator.fromDoc(doc);
    assert.equal(opened, 1);
  } finally {
    validator?.dispose();
    doc?.dispose();
    lib.xmlCleanupInputProvider();
  }
});
test("hard deadline terminates a deliberately CPU-bound worker while host event loop remains responsive", async () => {
  let heartbeat = false;
  const timer = setTimeout(() => (heartbeat = true), 5);
  try {
    await assert.rejects(
      compileIsolatedSchema(schema(""), {
        workerURL: "data:text/javascript,while(true){}",
        timeoutMs: 50,
      }),
      { code: "TIMEOUT" },
    );
    assert.equal(heartbeat, true);
  } finally {
    clearTimeout(timer);
  }
});
test("abort/dispose are explicit and handles cannot be reused; queue and diagnostics bounds", async () => {
  await assert.rejects(
    compileIsolatedSchema(schema(""), { signal: { aborted: true } }),
    { code: "ABORTED" },
  );
  const c = await compileIsolatedSchema(
    schema('<xs:element name="r" type="xs:integer"/>'),
    { maxQueue: 1 },
  );
  try {
    await assert.rejects(c.validate("<r/>", { signal: { aborted: true } }), {
      code: "ABORTED",
    });
    await assert.rejects(
      c.validate(
        '<r xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="file:///secret"/>',
      ),
      { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
    );
    assert.equal((await c.validate("<r>1</r>")).valid, true);
  } finally {
    c.dispose();
    c.dispose();
  }
  assert.equal(c.disposed, true);
  await assert.rejects(c.validate("<r>1</r>"), { code: "DISPOSED" });
});

test("opt-in schema hints resolve only checked catalogued resources and retain instance hints", async () => {
  const { compileIsolatedSchemaFromHints } = await import(
    "../dist/schema-isolated.js"
  );
  const instance = text(
    '<r xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="root.xsd">1</r>',
    "https://hints.invalid/instance.xml",
  );
  const calls = [];
  const c = await compileIsolatedSchemaFromHints(instance, {
    resolver: (request) => {
      calls.push(request);
      return schema('<xs:element name="r" type="xs:integer"/>');
    },
  });
  try {
    assert.equal((await c.validate(instance)).valid, true);
    assert.equal((await c.validate("<r>2</r>")).valid, true);
    assert.equal(calls[0].kind, "hint");
    await assert.rejects(
      c.validate(
        text(instance.text.replace("root.xsd", "other.xsd"), instance.systemId),
      ),
      { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
    );
  } finally {
    c.dispose();
  }
  const named = text(
    '<r xmlns="urn:r" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:r types.xsd"/>',
    "https://hints.invalid/named.xml",
  );
  const d = await compileIsolatedSchemaFromHints(named, {
    resourceMap: {
      "https://hints.invalid/types.xsd": `<xs:schema xmlns:xs="${X}" targetNamespace="urn:r"><xs:element name="r"/></xs:schema>`,
    },
  });
  try {
    assert.equal((await d.validate(named)).valid, true);
  } finally {
    d.dispose();
  }
});
test("hints reject malformed pairs, duplicates, absent hints, root mismatch, unknown resources and namespace mismatch", async () => {
  const { compileIsolatedSchemaFromHints } = await import(
    "../dist/schema-isolated.js"
  );
  const xml = (value) =>
    `<r xmlns="urn:r" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${value}"/>`;
  for (const value of [
    "urn:r",
    "urn:r one.xsd urn:r two.xsd",
    "urn:other one.xsd",
  ])
    await assert.rejects(compileIsolatedSchemaFromHints(xml(value)), {
      code: "INVALID_XML",
    });
  await assert.rejects(compileIsolatedSchemaFromHints("<r/>"), {
    code: "INVALID_XML",
  });
  await assert.rejects(
    compileIsolatedSchemaFromHints(xml("urn:r https://hints.invalid/x.xsd")),
    { code: "EXTERNAL_RESOURCE_FORBIDDEN" },
  );
  await assert.rejects(
    compileIsolatedSchemaFromHints(xml("urn:r https://hints.invalid/x.xsd"), {
      resourceMap: { "https://hints.invalid/x.xsd": schema("") },
    }),
    { code: "INVALID_SCHEMA" },
  );
});

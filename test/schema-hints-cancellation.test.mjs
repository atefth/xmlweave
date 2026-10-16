import test from "node:test";
import assert from "node:assert/strict";
import { createHintValidator } from "../dist/schema-hints.js";
const schema =
  '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r" type="xs:int"/></xs:schema>';
const xml =
  '<r xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:lifecycle:schema">1</r>';
function gate() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
function handle() {
  return {
    disposed: false,
    dispose() {
      this.disposed = true;
    },
    async validate() {
      return { valid: true, diagnostics: [] };
    },
  };
}
for (const phase of ["resolver", "compiler"])
  test(
    `cancelled hint ${phase} waiter releases admission while shared work survives`,
    { timeout: 5000 },
    async () => {
      const entered = gate(),
        release = gate();
      let calls = 0;
      const validator = await createHintValidator({
        maxPendingValidations: 1,
        ...(phase === "compiler"
          ? { resourceMap: { "urn:lifecycle:schema": schema } }
          : {}),
        resolver: async () => {
          calls++;
          entered.resolve();
          await release.promise;
          return schema;
        },
        compiler: async () => {
          if (phase === "compiler") {
            calls++;
            entered.resolve();
            await release.promise;
          }
          return handle();
        },
      });
      try {
        const signal = { aborted: false };
        const first = validator.validate(xml, { signal });
        const rejected = assert.rejects(first, { code: "ABORTED" });
        await entered.promise;
        signal.aborted = true;
        await rejected;
        const second = validator.validate(xml);
        release.resolve();
        assert.equal((await second).valid, true);
        assert.equal(calls, 1);
      } finally {
        release.resolve();
        validator.dispose();
      }
    },
  );
test("already-aborted hint callers do not consume admission tickets", async () => {
  const validator = await createHintValidator({
    maxPendingValidations: 1,
    resourceMap: { "urn:lifecycle:schema": schema },
    compiler: async () => handle(),
  });
  try {
    for (let i = 0; i < 10; i++)
      await assert.rejects(
        validator.validate(xml, { signal: { aborted: true } }),
        { code: "ABORTED" },
      );
    assert.equal((await validator.validate(xml)).valid, true);
  } finally {
    validator.dispose();
  }
});
test(
  "cancelled queued hint waiters unlink without letting successors overlap active validation",
  { timeout: 5000 },
  async () => {
    const entered = gate(),
      release = gate();
    let active = 0,
      peak = 0,
      calls = 0;
    const compiled = handle();
    compiled.validate = async () => {
      active++;
      peak = Math.max(peak, active);
      if (calls++ === 0) {
        entered.resolve();
        await release.promise;
      }
      active--;
      return { valid: true, diagnostics: [] };
    };
    const validator = await createHintValidator({
      maxPendingValidations: 2,
      resourceMap: { "urn:lifecycle:schema": schema },
      compiler: async () => compiled,
    });
    try {
      const first = validator.validate(xml);
      await entered.promise;
      for (let i = 0; i < 10; i++) {
        const signal = { aborted: false };
        const pending = validator.validate(xml, { signal });
        const rejected = assert.rejects(pending, { code: "ABORTED" });
        await new Promise((resolve) => setTimeout(resolve, 2));
        signal.aborted = true;
        await rejected;
      }
      const last = validator.validate(xml);
      release.resolve();
      assert.equal((await first).valid, true);
      assert.equal((await last).valid, true);
      assert.equal(peak, 1);
      assert.equal(calls, 2);
    } finally {
      release.resolve();
      validator.dispose();
    }
  },
);

const hinted = (id) => xml.replace("urn:lifecycle:schema", id);
test(
  "aborted callers cannot accumulate distinct pending catalogue resolutions",
  { timeout: 5000 },
  async () => {
    const entered = gate(),
      release = gate();
    let calls = 0;
    const validator = await createHintValidator({
      maxDocuments: 1,
      maxPendingValidations: 1,
      resolver: async () => {
        calls++;
        entered.resolve();
        await release.promise;
        return schema;
      },
      compiler: async () => handle(),
    });
    try {
      const signal = { aborted: false };
      const first = validator.validate(hinted("urn:pending:first"), { signal });
      const rejected = assert.rejects(first, { code: "ABORTED" });
      await entered.promise;
      signal.aborted = true;
      await rejected;
      for (let i = 0; i < 3; i++)
        await assert.rejects(
          validator.validate(hinted(`urn:pending:other:${i}`)),
          { code: "RESOURCE_LIMIT" },
        );
      assert.equal(calls, 1);
      const shared = validator.validate(hinted("urn:pending:first"));
      release.resolve();
      assert.equal((await shared).valid, true);
      assert.equal(calls, 1);
      assert.equal(
        (await validator.validate(hinted("urn:pending:first"))).valid,
        true,
      );
      await assert.rejects(validator.validate(hinted("urn:pending:another")), {
        code: "RESOURCE_LIMIT",
      });
      assert.equal(calls, 1);
    } finally {
      release.resolve();
      validator.dispose();
    }
  },
);
test("failed catalogue resolution releases reservation for another URI", async () => {
  let calls = 0;
  const sentinel = new Error("resolver failure");
  const validator = await createHintValidator({
    maxDocuments: 1,
    resolver: async () => {
      if (calls++ === 0) throw sentinel;
      return schema;
    },
    compiler: async () => handle(),
  });
  try {
    await assert.rejects(
      validator.validate(hinted("urn:reservation:failed")),
      (error) => error === sentinel,
    );
    assert.equal(
      (await validator.validate(hinted("urn:reservation:replacement"))).valid,
      true,
    );
    assert.equal(calls, 2);
  } finally {
    validator.dispose();
  }
});
test("successful catalogue resolutions become one pinned slot each", async () => {
  let calls = 0;
  const validator = await createHintValidator({
    maxDocuments: 2,
    resolver: async () => {
      calls++;
      return schema;
    },
    compiler: async () => handle(),
  });
  try {
    for (const id of [
      "urn:reservation:a",
      "urn:reservation:b",
      "urn:reservation:a",
    ])
      assert.equal((await validator.validate(hinted(id))).valid, true);
    await assert.rejects(validator.validate(hinted("urn:reservation:c")), {
      code: "RESOURCE_LIMIT",
    });
    assert.equal(calls, 2);
  } finally {
    validator.dispose();
  }
});

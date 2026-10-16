import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const catalogue = JSON.parse(
  await readFile(new URL("test/fixtures/xsd-original.json", root), "utf8"),
);
const encode = (text) => Buffer.from(text, "utf8").toString("base64");
const input =
  catalogue.fixtures
    .flatMap((f) => [
      encode(f.schema),
      String(f.instances.length),
      ...f.instances.map((i) => encode(i.xml)),
    ])
    .join("\n") + "\n";
const version = spawnSync("java", ["-version"], {
  encoding: "utf8",
  timeout: 10_000,
});
if (version.error || version.status !== 0)
  throw new Error(
    "Java reference runtime is required for this differential check.",
  );
const run = spawnSync(
  "java",
  [fileURLToPath(new URL("test/java/XsdReference.java", root))],
  {
    input,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4_000_000,
  },
);
if (run.error || run.status !== 0)
  throw new Error(`Java reference failed: ${run.error?.message ?? run.stderr}`);
const lines = run.stdout.trim().split(/\r?\n/);
const results = [];
for (const fixture of catalogue.fixtures) {
  const actual = lines.shift();
  results.push({
    fixture: fixture.id,
    phase: "schema",
    expected: fixture.schemaValid,
    actual: actual === "schema:valid",
    raw: actual,
  });
  for (const instance of fixture.instances) {
    const value = lines.shift();
    results.push({
      fixture: fixture.id,
      instance: instance.id,
      phase: "instance",
      expected: instance.valid,
      actual: value === "instance:valid",
      raw: value,
    });
  }
}
if (
  lines.length ||
  results.some((r) => !/^(schema|instance):(valid|invalid)$/.test(r.raw ?? ""))
)
  throw new Error("Unexpected reference protocol output.");
const failures = results.filter((r) => r.actual !== r.expected);
await mkdir(new URL(".artifacts/", root), { recursive: true });
await writeFile(
  new URL(".artifacts/java-conformance.json", root),
  JSON.stringify(
    {
      runtime: version.stderr.trim(),
      fixtureVersion: catalogue.version,
      groups: catalogue.fixtures.length,
      results,
      failures,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Java reference: ${results.length - failures.length}/${results.length} schema and instance expectations across ${catalogue.fixtures.length} feature groups.`,
);
if (failures.length) {
  console.error(failures);
  process.exitCode = 1;
}

import { build } from "esbuild";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  copyFile,
  readdir,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const nativeProvenance = JSON.parse(
  await readFile("native/runtime/provenance.json", "utf8"),
);
for (const [path, expected] of Object.entries(nativeProvenance.sha256)) {
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (actual !== expected)
    throw new Error(
      `Native asset/source mismatch: ${path}. Rebuild with npm run build:native.`,
    );
}
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const modules = {
  index: [["slimdom", "LICENSE"]],
  xpath: [
    ["fontoxpath", "LICENSE.md"],
    ["prsc", "LICENSE"],
    ["xspattern", "LICENSE"],
  ],
  stream: [
    ["saxes", "LICENSE"],
    ["xmlchars", "LICENSE"],
  ],
  "validation-types": [],
  schema: [],
  transform: [],
  "schema-isolated": [],
  "schema-java": [],
  "schema-xerces": [],
  "schema-xerces-isolated": [],
  "schema-pipeline": [],
  "schema-factory": [],
  "schema-providers": [],
  "schema-hints": [],
};
const namesBuilt = [];
for (const [name, licenses] of Object.entries(modules)) {
  try {
    await access(`src/${name}.ts`);
  } catch {
    continue;
  }
  const notices = [];
  for (const [dependency, filename] of licenses) {
    const text = await readFile(
      dependency === "saxes"
        ? "licenses/saxes.LICENSE"
        : `node_modules/${dependency}/${filename}`,
      "utf8",
    );
    await writeFile(`dist/${dependency}.LICENSE`, text);
    notices.push(`${dependency}\n${text}`);
  }
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `dist/${name}.cjs`,
    bundle: true,
    platform: "neutral",
    mainFields: ["module", "main"],
    format: "cjs",
    target: "es2022",
    sourcemap: true,
    external: [
      "libxml2-wasm",
      "xslt-processor",
      "node:*",
      "./vendor-worker-node.js",
      "./vendor-java-node.js",
      "./vendor-xerces-runtime.js",
      "./vendor-xerces-worker-node.js",
    ],
    plugins: [
      {
        name: "shared-core",
        setup(builder) {
          if (name !== "index")
            builder.onResolve({ filter: /^\.\/index\.js$/ }, () => ({
              path: "./index.cjs",
              external: true,
            }));
          if (name !== "validation-types")
            builder.onResolve({ filter: /^\.\/validation-types\.js$/ }, () => ({
              path: "./validation-types.cjs",
              external: true,
            }));
        },
      },
    ],
    banner: notices.length
      ? { js: `/*! Bundled dependency notices\n${notices.join("\n\n")}\n*/` }
      : undefined,
  });
  const api = await import(new URL(`../dist/${name}.cjs`, import.meta.url));
  const exported = Object.keys(api.default).filter(
    (key) => key !== "__esModule",
  );
  await writeFile(
    `dist/${name}.js`,
    `import implementation from './${name}.cjs';\nexport const { ${exported.join(", ")} } = implementation;\n`,
  );
  namesBuilt.push(name);
}
try {
  await access("src/schema-worker.ts");
  await build({
    entryPoints: ["src/schema-worker.ts"],
    outfile: "dist/schema-worker.js",
    bundle: true,
    platform: "neutral",
    mainFields: ["module", "main"],
    format: "esm",
    target: "es2022",
    external: ["libxml2-wasm", "node:*"],
  });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  await access("src/schema-xerces-worker.ts");
  await build({
    entryPoints: ["src/schema-xerces-worker.ts"],
    outfile: "dist/schema-xerces-worker.js",
    bundle: true,
    platform: "neutral",
    mainFields: ["module", "main"],
    format: "esm",
    target: "es2022",
    external: ["node:*", "./vendor-xerces-runtime.js"],
  });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const filename of [
  "vendor-xerces-worker-node.js",
  "vendor-worker-node.js",
  "vendor-java-node.js",
  "vendor-xerces-runtime.js",
]) {
  try {
    await copyFile(`src/${filename}`, `dist/${filename}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
for (const filename of ["xerces-engine.js", "xerces-engine.wasm"]) {
  try {
    await copyFile(`native/runtime/${filename}`, `dist/${filename}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
await copyFile("native/runtime/provenance.json", "dist/xerces-provenance.json");
try {
  await access("java/ValidationBridge.java");
  await mkdir("dist/java", { recursive: true });
  await copyFile(
    "java/ValidationBridge.java",
    "dist/java/ValidationBridge.java",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
  { stdio: "inherit" },
);
for (const name of (await readdir("dist"))
  .filter((file) => file.endsWith(".d.ts"))
  .map((file) => file.slice(0, -5))) {
  const declaration = await readFile(`dist/${name}.d.ts`, "utf8");
  await writeFile(
    `dist/${name}.d.cts`,
    declaration
      .replace(/import \* as dom from/, "import type * as dom from")
      .replace(
        /(from\s+['"]slimdom['"])(\s*;)/g,
        '$1 with { "resolution-mode": "import" }$2',
      )
      .replace(/(['"])\.\/([A-Za-z0-9_-]+)\.js\1/g, "$1./$2.cjs$1"),
  );
}
console.log(
  `Built shared implementations and ESM/CJS declarations: ${namesBuilt.join(", ")}.`,
);

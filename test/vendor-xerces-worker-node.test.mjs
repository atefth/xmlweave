import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("Xerces workers do not inherit incompatible parent runtime flags", () => {
  const factory = new URL(
    "../src/vendor-xerces-worker-node.js",
    import.meta.url,
  ).href;
  const workerURL = new URL(
    "data:text/javascript," +
      encodeURIComponent(
        'import{parentPort}from"node:worker_threads";parentPort.postMessage(process.execArgv);',
      ),
  ).href;
  const code = `import{createXercesWorker}from ${JSON.stringify(factory)};
const worker=createXercesWorker(${JSON.stringify(workerURL)});
try{const flags=await new Promise((resolve,reject)=>worker.listen(resolve,reject));console.log(JSON.stringify(flags));}finally{await worker.terminate();}`;
  assert.equal(
    execFileSync(
      process.execPath,
      [
        "--stack-trace-limit=64",
        "--v8-pool-size=2",
        "--tls-min-v1.2",
        "--input-type=module",
        "-e",
        code,
      ],
      { encoding: "utf8", timeout: 10000 },
    ).trim(),
    "[]",
  );
});

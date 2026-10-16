import { Worker } from "node:worker_threads";
export function createNodeSchemaWorker(workerURL) {
  const worker = new Worker(
    workerURL
      ? new URL(workerURL)
      : new URL("./schema-worker.js", import.meta.url),
    { type: "module" },
  );
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
    listen: (message, error) => {
      worker.on("message", message);
      worker.on("error", error);
      worker.on("exit", (code) => {
        if (code !== 0) error(new Error("Schema worker exited unexpectedly."));
      });
    },
  };
}

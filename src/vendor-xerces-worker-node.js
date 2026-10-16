import { Worker } from "node:worker_threads";
export function createXercesWorker(workerURL) {
  const worker = new Worker(
    workerURL
      ? new URL(workerURL)
      : new URL("./schema-xerces-worker.js", import.meta.url),
    {
      type: "module",
      // The bundled worker needs no parent CLI flags; some are invalid in workers.
      execArgv: [],
    },
  );
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
    listen: (message, error) => {
      worker.on("message", message);
      worker.on("error", error);
      worker.on("exit", (code) => {
        if (code !== 0) error(new Error("Xerces worker exited unexpectedly."));
      });
    },
  };
}

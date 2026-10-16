import { Worker } from "node:worker_threads";
export function createXercesWorker(workerURL) {
  const worker = new Worker(
    workerURL
      ? new URL(workerURL)
      : new URL("./schema-xerces-worker.js", import.meta.url),
    {
      type: "module",
      execArgv: process.execArgv.filter(
        (value, index, args) =>
          !value.startsWith("--input-type=") &&
          value !== "--input-type" &&
          !(index > 0 && args[index - 1] === "--input-type"),
      ),
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

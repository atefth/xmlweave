import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export function startJava(options = {}) {
  const child = spawn(
    options.javaExecutable ?? "java",
    [
      "--add-exports=java.xml/com.sun.org.apache.xerces.internal.xs=ALL-UNNAMED",
      fileURLToPath(new URL("./java/ValidationBridge.java", import.meta.url)),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let queue = [],
    pending,
    terminal,
    buffer = "",
    stderr = "";
  const writers = new Set();
  const finish = (error) => {
    terminal = error;
    for (const reject of writers) reject(error);
    writers.clear();
    if (pending) {
      pending.reject(error);
      pending = undefined;
    }
  };
  child.on("error", finish);
  child.on("exit", () =>
    finish(new Error(`Java provider exited. ${stderr.slice(0, 1024)}`)),
  );
  child.stdin.on("error", finish);
  const started = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  started.catch(() => {});
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString()).slice(-4096);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    buffer += data;
    if (buffer.length > 32 * 1024 * 1024) {
      child.kill();
      finish(new Error("Java output frame limit exceeded."));
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        child.kill();
        finish(new Error("Invalid Java protocol output."));
        return;
      }
      if (pending) {
        const resolve = pending.resolve;
        pending = undefined;
        resolve(value);
      } else queue.push(value);
    }
    if (queue.length) child.stdout.pause();
  });
  return {
    async send(text) {
      await started;
      if (terminal) throw terminal;
      const data = Buffer.from(text, "utf8");
      if (data.length > 16 * 1024 * 1024)
        throw new Error("Java input frame limit exceeded.");
      const header = Buffer.alloc(4);
      header.writeInt32BE(data.length);
      for (const part of [header, data])
        if (!child.stdin.write(part))
          await new Promise((resolve, reject) => {
            const done = () => {
              writers.delete(fail);
              child.stdin.off("error", fail);
              resolve();
            };
            const fail = (e) => {
              writers.delete(fail);
              child.stdin.off("drain", done);
              reject(e);
            };
            writers.add(fail);
            child.stdin.once("drain", done);
            child.stdin.once("error", fail);
          });
    },
    async next() {
      if (queue.length) {
        const value = queue.shift();
        if (!queue.length) child.stdout.resume();
        return value;
      }
      if (terminal) throw terminal;
      child.stdout.resume();
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    close() {
      finish(new Error("Java provider was terminated."));
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill();
    },
  };
}

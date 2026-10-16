import { normalizeSchemaSource } from "./schema-sources.js";
import { SchemaError } from "./validation-types.js";
import type {
  SchemaSource,
  SchemaSourceOptions,
  SchemaSignal,
} from "./validation-types.js";

export function remainingSourceTimeout(
  timeoutMs: number | undefined,
  started: number,
): number {
  const remaining = (timeoutMs ?? 30_000) - (Date.now() - started);
  if (remaining <= 0)
    throw new SchemaError("TIMEOUT", "Schema operation deadline exceeded.");
  return remaining;
}

/** Deadline covers asynchronous producers, not just native CPU work. */
export async function withinSourceDeadline<T>(
  work: (signal: SchemaSignal) => Promise<T>,
  options: { timeoutMs?: number; signal?: SchemaSignal },
  disposed?: () => boolean,
  cancel?: () => void,
): Promise<T> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 3_600_000)
  ) {
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "timeoutMs must be an integer from 1 to 3600000.",
    );
  }
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const signal = {
    get aborted() {
      return (
        cancelled || options.signal?.aborted === true || disposed?.() === true
      );
    },
  };
  try {
    return await new Promise<T>((resolve, reject) => {
      const stop = (error: SchemaError) => {
        if (cancelled) return;
        cancelled = true;
        try {
          cancel?.();
        } catch {}
        reject(error);
      };
      const check = () => {
        if (disposed?.())
          stop(
            new SchemaError(
              "DISPOSED",
              "The schema was disposed while awaiting input.",
            ),
          );
        else if (options.signal?.aborted)
          stop(new SchemaError("ABORTED", "Schema input was aborted."));
      };
      check();
      if (cancelled) return;
      timer = setTimeout(
        () =>
          stop(new SchemaError("TIMEOUT", "Schema input deadline exceeded.")),
        options.timeoutMs ?? 30_000,
      );
      poll = setInterval(check, 5);
      Promise.resolve()
        .then(() => work(signal))
        .then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
  }
}

export function normalizeSourceWithDeadline(
  source: SchemaSource,
  options: SchemaSourceOptions & { timeoutMs?: number },
  disposed?: () => boolean,
) {
  let iterator:
    | AsyncIterator<string | Uint8Array>
    | Iterator<string | Uint8Array>
    | undefined;
  let returned = false;
  const close = () => {
    if (returned) return;
    returned = true;
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => {});
    } catch {}
  };
  let guarded = source;
  if (
    typeof source === "object" &&
    source !== null &&
    source.kind === "chunks"
  ) {
    const chunks = source.chunks;
    if (
      !chunks ||
      (typeof (chunks as AsyncIterable<unknown>)[Symbol.asyncIterator] !==
        "function" &&
        typeof (chunks as Iterable<unknown>)[Symbol.iterator] !== "function")
    ) {
      return normalizeSchemaSource(source, options);
    }
    guarded = {
      ...source,
      chunks: {
        [Symbol.asyncIterator]() {
          const asyncFactory = (chunks as AsyncIterable<string | Uint8Array>)[
            Symbol.asyncIterator
          ];
          const syncFactory = (chunks as Iterable<string | Uint8Array>)[
            Symbol.iterator
          ];
          iterator =
            typeof asyncFactory === "function"
              ? asyncFactory.call(chunks)
              : syncFactory.call(chunks);
          if (!iterator || typeof iterator.next !== "function")
            throw new SchemaError(
              "INVALID_ARGUMENT",
              "Source must provide an iterator with next().",
            );
          return {
            next: async () => {
              const result = await iterator!.next();
              if (!result || typeof result !== "object")
                throw new SchemaError(
                  "INVALID_ARGUMENT",
                  "Source iterator must return an iteration result.",
                );
              return result;
            },
            return: async () => {
              close();
              return { done: true as const, value: undefined };
            },
          };
        },
      },
    };
  }
  return withinSourceDeadline(
    (signal) => normalizeSchemaSource(guarded, { ...options, signal }),
    options,
    disposed,
    close,
  ).catch((cause) => {
    close();
    throw cause;
  });
}

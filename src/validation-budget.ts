import { SchemaError } from "./validation-types.js";

/** Counts the logical SAX tree without retaining document contents. */
export function createValidationBudget() {
  let depth = 0;
  let nodes = 1; // document
  let previousText = false;
  const add = (count: number) => {
    nodes += count;
    if (nodes > 100_000)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "Validation exceeds the 100000-node limit.",
      );
  };
  return (event: {
    kind: string;
    attributes?: readonly unknown[];
    text?: string;
  }) => {
    if (event.kind === "startElement") {
      if (++depth > 256)
        throw new SchemaError(
          "RESOURCE_LIMIT",
          "Validation exceeds the 256-element depth limit.",
        );
      add(1 + (event.attributes?.length ?? 0));
    } else if (event.kind === "endElement") {
      depth--;
    } else if (
      event.kind === "startPrefixMapping" ||
      event.kind === "processingInstruction" ||
      event.kind === "comment"
    ) {
      add(1);
    } else if (event.kind === "text") {
      if (!event.text?.length) return;
      if (!previousText && event.text?.length) add(1);
      previousText = true;
      return;
    } else if (event.kind === "diagnostic" || event.kind === "result") {
      return;
    }
    previousText = false;
  };
}

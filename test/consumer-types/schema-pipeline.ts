// Compile-only fixture appended to packed ESM/CJS consumer sources.
import { compileXercesSchema as compileRawNativeForPipeline } from "xmlweave/schema-xerces";
import { compileJavaSchema as compileJavaForPipeline } from "xmlweave/schema-java";
import { compileIsolatedXercesSchema as compileIsolatedForPipeline } from "xmlweave/schema-xerces-isolated";
import {
  validateEventStream as typedEventStream,
  validateSource as typedValidateSource,
  createValidationHandler as typedHandler,
  type NativeSchemaValidator,
  type ValidationInputEvent,
} from "xmlweave/schema-pipeline";
export function checkPackedProviderPipelines(
  raw: Awaited<ReturnType<typeof compileRawNativeForPipeline>>,
  java: Awaited<ReturnType<typeof compileJavaForPipeline>>,
  isolated: Awaited<ReturnType<typeof compileIsolatedForPipeline>>,
  inputEvents: AsyncIterable<ValidationInputEvent>,
): void {
  const providers: readonly NativeSchemaValidator[] = [raw, java, isolated];
  for (const provider of providers) {
    const output = typedEventStream(provider, inputEvents, {
      namespacePrefixes: true,
      diagnosticHandler: async (diagnostic) => {
        const sourceLine: number | undefined =
          diagnostic.location?.source?.line;
        void sourceLine;
      },
    });
    const handler = typedHandler(provider, {
      diagnosticHandler: (diagnostic) => {
        void diagnostic.location?.generated.column;
      },
    });
    const collected = typedValidateSource(
      provider,
      { family: "stream", source: "<r/>" },
      "text",
      {
        diagnosticHandler: async (diagnostic) => {
          void diagnostic.provenance;
        },
      },
    );
    void [output, handler, collected];
  }
}

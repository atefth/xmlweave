import type {
  SchemaProvider,
  ProviderConfiguration,
} from "./schema-factory.js";
import { compileXercesSchema } from "./schema-xerces.js";
import type {
  XercesCompiledSchema,
  XercesSchemaOptions,
} from "./schema-xerces.js";
import type { JavaCompiledSchema, JavaSchemaOptions } from "./schema-java.js";
import { SchemaError } from "./validation-types.js";
import type { SchemaOptions } from "./validation-types.js";

export const validationPolicyNames = Object.freeze({
  secureProcessing: "http://javax.xml.XMLConstants/feature/secure-processing",
  externalDTD: "http://javax.xml.XMLConstants/property/accessExternalDTD",
  externalSchema: "http://javax.xml.XMLConstants/property/accessExternalSchema",
});
const safetyFeatures = {
  [validationPolicyNames.secureProcessing]: Object.freeze([true]),
};
const safetyProperties = {
  [validationPolicyNames.externalDTD]: {
    defaultValue: "",
    allowedValues: Object.freeze([""]),
  },
  [validationPolicyNames.externalSchema]: {
    defaultValue: "",
    allowedValues: Object.freeze([""]),
  },
};
const schemaLanguages = Object.freeze(["http://www.w3.org/2001/XMLSchema"]);
function compileOptions<T extends SchemaOptions & { timeoutMs?: number }>(
  base: T,
  operation: SchemaOptions,
): T {
  const supplied = Object.fromEntries(
    Object.entries(operation).filter(([, value]) => value !== undefined),
  );
  for (const key of [
    "maxBytes",
    "maxCharacters",
    "maxDiagnostics",
    "timeoutMs",
  ] as const) {
    if (
      base[key] !== undefined &&
      (supplied[key] as number | undefined) !== undefined &&
      (supplied[key] as number) > base[key]!
    ) {
      throw new SchemaError(
        "INVALID_ARGUMENT",
        `${key} cannot exceed the factory safety limit.`,
      );
    }
  }
  return { ...base, ...supplied };
}
function safety(configuration: ProviderConfiguration): void {
  if (
    configuration.features[validationPolicyNames.secureProcessing] !== true ||
    configuration.properties[validationPolicyNames.externalDTD] !== "" ||
    configuration.properties[validationPolicyNames.externalSchema] !== ""
  ) {
    throw new Error(
      "Factory configuration must preserve explicit resource isolation.",
    );
  }
}

/** Shipped provider definitions bind negotiated settings to the actual engine. */
export function xercesSchemaProvider(
  options: XercesSchemaOptions = {},
): SchemaProvider<XercesCompiledSchema> {
  const snapshot = {
    ...options,
    features: { ...options.features },
    typeQueries: options.typeQueries?.map((query) => ({ ...query })),
  };
  const feature = (
    key: "fullSchemaChecking" | "identityConstraints" | "multipleImports",
  ) => {
    const preferred = snapshot.features[key] ?? true;
    return Object.freeze([preferred, !preferred]);
  };
  return Object.freeze<SchemaProvider<XercesCompiledSchema>>({
    id: "xmlweave-xerces",
    version: "4.0.0",
    capabilities: Object.freeze({
      schemaLanguages,
      incrementalValidation: true,
      typeInformation: true,
      hardTimeout: false,
    }),
    features: Object.freeze({
      ...safetyFeatures,
      fullSchemaChecking: feature("fullSchemaChecking"),
      identityConstraints: feature("identityConstraints"),
      multipleImports: feature("multipleImports"),
    }),
    properties: Object.freeze(safetyProperties),
    compile(source, operation, configuration) {
      safety(configuration);
      return compileXercesSchema(source, {
        ...compileOptions(snapshot, operation),
        features: {
          fullSchemaChecking: configuration.features.fullSchemaChecking,
          identityConstraints: configuration.features.identityConstraints,
          multipleImports: configuration.features.multipleImports,
        },
      });
    },
  });
}

/** Explicit selection of this definition is the only step that can start Java. */
export function javaSchemaProvider(
  options: JavaSchemaOptions = {},
): SchemaProvider<JavaCompiledSchema> {
  const snapshot = {
    ...options,
    typeQueries: options.typeQueries?.map((query) => ({ ...query })),
  };
  return Object.freeze<SchemaProvider<JavaCompiledSchema>>({
    id: "xmlweave-java",
    version: "JAXP-Java17+",
    capabilities: Object.freeze({
      schemaLanguages,
      incrementalValidation: true,
      typeInformation: true,
      hardTimeout: true,
    }),
    features: Object.freeze(safetyFeatures),
    properties: Object.freeze(safetyProperties),
    async compile(source, operation, configuration) {
      safety(configuration);
      if (
        !(
          globalThis as unknown as {
            process?: { versions?: { node?: string } };
          }
        ).process?.versions?.node
      )
        throw new SchemaError(
          "UNSUPPORTED_CAPABILITY",
          "The explicitly selected Java provider requires Node.",
        );
      const modulePath = "./schema-java.js";
      const { compileJavaSchema } = await import(modulePath);
      return compileJavaSchema(source, compileOptions(snapshot, operation));
    },
  });
}

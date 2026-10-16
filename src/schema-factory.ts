import { SchemaError } from "./validation-types.js";
import type { SchemaOptions, SchemaSource } from "./validation-types.js";
import type { NativeSchemaValidator } from "./schema-pipeline.js";
import { sourceLimits } from "./schema-sources.js";
export type SchemaCapabilityValue =
  | boolean
  | string
  | number
  | readonly string[];
export interface ProviderProperty {
  readonly defaultValue?: string | number | boolean;
  readonly allowedValues?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
}
export interface ProviderConfiguration {
  readonly features: Readonly<Record<string, boolean>>;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}
export interface SchemaProvider<C = NativeSchemaValidator> {
  readonly id: string;
  readonly version: string;
  readonly capabilities: Readonly<Record<string, SchemaCapabilityValue>>;
  /** Supported feature settings are applied by compile; boolean arrays enumerate permitted values. */
  readonly features?: Readonly<Record<string, readonly boolean[]>>;
  readonly properties?: Readonly<Record<string, ProviderProperty>>;
  compile(
    source: SchemaSource | readonly SchemaSource[],
    options: SchemaOptions,
    configuration: ProviderConfiguration,
  ): Promise<C>;
}
export interface SchemaFactoryOptions {
  features?: Readonly<Record<string, boolean>>;
  properties?: Readonly<Record<string, string | number | boolean>>;
}
export interface SchemaFactory<C> {
  readonly provider: Readonly<{
    id: string;
    version: string;
    capabilities: Readonly<Record<string, SchemaCapabilityValue>>;
  }>;
  readonly configuration: ProviderConfiguration;
  supportsSchemaLanguage(language: string): boolean;
  getFeature(name: string): boolean;
  getProperty(name: string): string | number | boolean | undefined;
  compile(
    source: SchemaSource | readonly SchemaSource[],
    options?: SchemaOptions,
  ): Promise<C>;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const part of Object.values(value)) frozen(part);
    Object.freeze(value);
  }
  return value;
}
const invalid = (message: string): never => {
  throw new SchemaError("INVALID_ARGUMENT", message);
};
function own(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Explicit provider selection only. No global registration, discovery, fallback or automatic Java load. */
export function createSchemaFactory<C>(
  provider: SchemaProvider<C>,
  options: SchemaFactoryOptions = {},
): SchemaFactory<C> {
  if (
    !provider ||
    typeof provider.id !== "string" ||
    !provider.id ||
    typeof provider.version !== "string" ||
    !provider.version ||
    typeof provider.compile !== "function" ||
    !own(provider.capabilities)
  )
    invalid("Provider requires identity, capabilities and compile.");
  if (
    !own(options) ||
    Object.keys(options).some(
      (key) => !["features", "properties"].includes(key),
    )
  )
    invalid("Invalid factory options.");
  if (options.features !== undefined && !own(options.features))
    invalid("features must be an object.");
  if (options.properties !== undefined && !own(options.properties))
    invalid("properties must be an object.");
  const capabilities: Record<string, SchemaCapabilityValue> =
    Object.create(null);
  for (const [key, value] of Object.entries(provider.capabilities)) {
    if (
      !["boolean", "string", "number"].includes(typeof value) &&
      !(Array.isArray(value) && value.every((v) => typeof v === "string"))
    )
      invalid(`Invalid capability ${key}.`);
    if (typeof value === "number" && !Number.isFinite(value))
      invalid(`Invalid capability ${key}.`);
    capabilities[key] = Array.isArray(value) ? [...value] : value;
  }
  const featureDefinitions = Object.fromEntries(
    Object.entries(provider.features ?? {}).map(([key, values]) => {
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.some((v) => typeof v !== "boolean")
      )
        invalid(`Invalid feature definition ${key}.`);
      return [key, [...values]];
    }),
  );
  const propertyDefinitions = Object.fromEntries(
    Object.entries(provider.properties ?? {}).map(([key, value]) => {
      if (
        !own(value) ||
        Object.keys(value).some(
          (k) =>
            !["defaultValue", "allowedValues", "minimum", "maximum"].includes(
              k,
            ),
        )
      )
        invalid(`Invalid property definition ${key}.`);
      if (
        value.allowedValues !== undefined &&
        (!Array.isArray(value.allowedValues) ||
          !value.allowedValues.length ||
          value.allowedValues.some(
            (v) =>
              !["string", "number", "boolean"].includes(typeof v) ||
              (typeof v === "number" && !Number.isFinite(v)),
          ))
      )
        invalid(`Invalid allowed values for ${key}.`);
      if (
        (value.minimum !== undefined && !Number.isFinite(value.minimum)) ||
        (value.maximum !== undefined && !Number.isFinite(value.maximum)) ||
        (value.minimum !== undefined &&
          value.maximum !== undefined &&
          value.minimum > value.maximum)
      )
        invalid(`Invalid property bounds ${key}.`);
      return [
        key,
        {
          ...value,
          allowedValues: value.allowedValues
            ? [...value.allowedValues]
            : undefined,
        },
      ];
    }),
  );
  const features: Record<string, boolean> = Object.create(null),
    properties: Record<string, string | number | boolean> = Object.create(null);
  for (const [key, values] of Object.entries(featureDefinitions))
    features[key] = values[0]!;
  for (const [key, value] of Object.entries(options.features ?? {})) {
    if (typeof value !== "boolean") invalid(`Feature ${key} must be boolean.`);
    if (
      !Object.hasOwn(featureDefinitions, key) ||
      !featureDefinitions[key]!.includes(value)
    )
      throw new SchemaError(
        "UNSUPPORTED_CAPABILITY",
        `Provider ${provider.id} does not support feature ${key}=${value}.`,
      );
    features[key] = value;
  }
  for (const [key, definition] of Object.entries(propertyDefinitions))
    if (definition.defaultValue !== undefined)
      properties[key] = definition.defaultValue;
  for (const [key, value] of Object.entries({
    ...properties,
    ...options.properties,
  })) {
    const definition = propertyDefinitions[key];
    if (!Object.hasOwn(propertyDefinitions, key))
      throw new SchemaError(
        "UNSUPPORTED_CAPABILITY",
        `Provider ${provider.id} does not support property ${key}.`,
      );
    if (
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      invalid(`Invalid property ${key}.`);
    if (definition!.allowedValues && !definition!.allowedValues.includes(value))
      throw new SchemaError(
        "UNSUPPORTED_CAPABILITY",
        `Unsupported value for property ${key}.`,
      );
    if (
      (definition!.minimum !== undefined &&
        (typeof value !== "number" || value < definition!.minimum)) ||
      (definition!.maximum !== undefined &&
        (typeof value !== "number" || value > definition!.maximum))
    )
      invalid(`Property ${key} is outside supported bounds.`);
    properties[key] = value;
  }
  const configuration = frozen({ features, properties }),
    snapshot = frozen({
      id: provider.id,
      version: provider.version,
      capabilities,
    });
  const compile = provider.compile.bind(provider);
  return Object.freeze({
    provider: snapshot,
    configuration,
    supportsSchemaLanguage(language: string) {
      if (typeof language !== "string" || !language)
        invalid("Schema language must be a non-empty string.");
      const languages = snapshot.capabilities.schemaLanguages;
      return Array.isArray(languages) && languages.includes(language);
    },
    getFeature(name: string) {
      if (!Object.hasOwn(features, name))
        throw new SchemaError(
          "UNSUPPORTED_CAPABILITY",
          `Unknown feature ${name}.`,
        );
      return features[name]!;
    },
    getProperty(name: string) {
      if (!Object.hasOwn(propertyDefinitions, name))
        throw new SchemaError(
          "UNSUPPORTED_CAPABILITY",
          `Unknown property ${name}.`,
        );
      return properties[name];
    },
    compile(
      source: SchemaSource | readonly SchemaSource[],
      operation: SchemaOptions = {},
    ) {
      sourceLimits(operation);
      if (
        Object.keys(operation).some(
          (key) =>
            ![
              "signal",
              "maxBytes",
              "maxCharacters",
              "maxDiagnostics",
              "onDiagnostic",
              "errorPolicy",
            ].includes(key),
        )
      )
        invalid("Unknown factory compile option.");
      if (
        operation.maxDiagnostics !== undefined &&
        (!Number.isSafeInteger(operation.maxDiagnostics) ||
          operation.maxDiagnostics < 1 ||
          operation.maxDiagnostics > 10000)
      )
        invalid("Invalid diagnostic budget.");
      if (
        operation.onDiagnostic !== undefined &&
        typeof operation.onDiagnostic !== "function"
      )
        invalid("Invalid diagnostic observer.");
      if (
        operation.errorPolicy !== undefined &&
        !["result", "throw"].includes(operation.errorPolicy)
      )
        invalid("Invalid error policy.");
      return compile(source, { ...operation }, configuration);
    },
  });
}
export function createSchemaProviderRegistry(
  providers: readonly SchemaProvider<unknown>[],
) {
  const factories = new Map<string, SchemaFactory<unknown>>();
  for (const provider of providers) {
    if (factories.has(provider.id)) invalid("Duplicate provider identifier.");
    factories.set(provider.id, createSchemaFactory(provider));
  }
  return Object.freeze({
    providers: Object.freeze(
      [...factories.values()].map((factory) => factory.provider),
    ),
    select(id: string) {
      const factory = factories.get(id);
      if (!factory)
        throw new SchemaError(
          "UNSUPPORTED_CAPABILITY",
          `No explicit provider registered as ${id}.`,
        );
      return factory;
    },
  });
}

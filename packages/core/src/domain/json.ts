export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** A JSON Schema document, kept opaque in the domain. Validation is an infrastructure concern. */
export type JsonSchema = Readonly<Record<string, unknown>>;

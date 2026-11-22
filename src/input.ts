import { ensure, text } from "./domain.js";

type FieldSchema = { type: "string"; minLength: number; maxLength: number; pattern?: string; enum?: string[] }
  | { type: "integer"; minimum: number; maximum: number }
  | { type: "array"; items: FieldSchema; maxItems: number; uniqueItems: boolean };
export interface Field<T> { schema: FieldSchema; decode(value: unknown, key: string): T; optional?: boolean }
export type Fields = Record<string, Field<unknown>>;
export type Parsed<F extends Fields> = { [K in keyof F]: F[K] extends Field<infer T> ? T : never };

export function string(maximum = 128, pattern?: string): Field<string> {
  return {
    schema: { type: "string", minLength: 1, maxLength: maximum, ...(pattern ? { pattern } : {}) },
    decode(value, key) {
      ensure(typeof value === "string", "INVALID", `${key} must be a string`);
      text(value, key, maximum);
      ensure(!pattern || new RegExp(pattern).test(value), "INVALID", `${key} has an invalid format`);
      return value;
    },
  };
}

export function optional<T>(field: Field<T>): Field<T | undefined> {
  return { schema: field.schema, optional: true, decode: (value, key) => value === undefined ? undefined : field.decode(value, key) };
}

export function integer(minimum = 0): Field<number> {
  return { schema: { type: "integer", minimum, maximum: Number.MAX_SAFE_INTEGER }, decode(value, key) {
    ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum, "INVALID", `${key} must be an integer at least ${minimum}`);
    return value;
  } };
}

export function strings(): Field<string[]> {
  const item = string();
  return { schema: { type: "array", items: item.schema, maxItems: 100, uniqueItems: true }, decode(value, key) {
    ensure(Array.isArray(value) && value.length <= 100, "INVALID", `${key} must be an array of at most 100 IDs`);
    const result = value.map((entry) => item.decode(entry, key));
    ensure(new Set(result).size === result.length, "INVALID", `${key} must not contain duplicates`);
    return result;
  } };
}

export function choice<const T extends string>(values: readonly T[]): Field<T> {
  return { schema: { type: "string", minLength: 1, maxLength: 64, enum: [...values] }, decode(value, key) {
    ensure(typeof value === "string" && values.includes(value as T), "INVALID", `${key} must be one of ${values.join(", ")}`);
    return value as T;
  } };
}

export function parameters<F extends Fields>(fields: F) {
  return { type: "object" as const, properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema])),
    required: Object.entries(fields).filter(([, field]) => !field.optional).map(([key]) => key), additionalProperties: false };
}

export function parse<F extends Fields>(fields: F, input: unknown): Parsed<F> {
  ensure(typeof input === "object" && input !== null && !Array.isArray(input), "INVALID", "Tool input must be an object");
  const values = input as Record<string, unknown>;
  for (const key of Object.keys(values)) ensure(Object.hasOwn(fields, key), "INVALID", `Unexpected input property: ${key}`);
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.decode(values[key], key)])) as Parsed<F>;
}

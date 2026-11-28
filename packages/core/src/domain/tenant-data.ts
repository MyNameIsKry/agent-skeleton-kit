/**
 * Rules shared by every TenantDataStore implementation (MongoDB and the in-memory fake), so a
 * handler behaves the same in tests and in production.
 *
 * - Collection names match COLLECTION_NAME.
 * - Top-level record, filter, and patch keys address the record's own top-level fields: no
 *   empty keys, no `$` operators, no dotted paths, no `__proto__`. Nested keys are stored as
 *   given; they cannot be queried, because filters only take scalar values.
 * - Filters are equality on scalar values (string, number, boolean, null). A filter on a field
 *   that holds an array matches when the array contains the value; `null` also matches a
 *   missing field. These are MongoDB's equality semantics.
 * - `undefined` values are stored as `null`, as the MongoDB driver does.
 */
import type { TenantRecord } from "./tool.js";

export const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export const DEFAULT_FIND_LIMIT = 100;
export const MAX_FIND_LIMIT = 1000;

export type FilterValue = string | number | boolean | null;

/** A handler used the data store wrongly. Thrown to the handler; never reaches the model as is. */
export class DataStoreUsageError extends Error {
  override readonly name = "DataStoreUsageError";
}

export function checkCollectionName(collection: string): void {
  if (!COLLECTION_NAME.test(collection)) {
    throw new DataStoreUsageError(`Invalid collection name "${collection}": use ${String(COLLECTION_NAME)}`);
  }
}

/** Returns the keys of `record` after checking them. */
export function checkRecordKeys(kind: "record" | "filter" | "patch", record: TenantRecord): string[] {
  const keys = Object.keys(record);
  for (const key of keys) {
    if (key === "" || key === "__proto__" || key.startsWith("$") || key.includes(".")) {
      throw new DataStoreUsageError(
        `Invalid ${kind} key "${key}": keys must not be empty, be "__proto__", start with "$", or contain "."`,
      );
    }
  }
  return keys;
}

/** Returns the defined filter entries after checking keys and values. */
export function checkFilter(filter: TenantRecord): [string, FilterValue][] {
  const entries: [string, FilterValue][] = [];
  for (const key of checkRecordKeys("filter", filter)) {
    const value = filter[key];
    if (value === undefined) continue;
    const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
    if (!scalar || (typeof value === "number" && !Number.isFinite(value))) {
      throw new DataStoreUsageError(
        `Invalid filter value for "${key}": use a string, a finite number, a boolean, or null`,
      );
    }
    entries.push([key, value as FilterValue]);
  }
  return entries;
}

export function checkFindLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1)
    throw new DataStoreUsageError("limit must be a positive integer");
  return Math.min(limit, MAX_FIND_LIMIT);
}

/** MongoDB equality semantics for one top-level field of `record`, used by the in-memory store. */
export function matchesFilterValue(record: TenantRecord, key: string, value: FilterValue): boolean {
  // Own fields only: `toString` or `constructor` must not match inherited properties.
  const field = Object.hasOwn(record, key) ? record[key] : undefined;
  if (value === null) {
    return field === null || field === undefined || (Array.isArray(field) && field.includes(null));
  }
  if (Array.isArray(field)) return field.some((item) => item === value);
  return field === value;
}

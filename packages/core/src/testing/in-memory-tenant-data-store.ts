/**
 * In-memory TenantDataStore with the same scoping, validation, and matching rules as the
 * MongoDB store (domain/tenant-data.ts), for handler tests without a database.
 *
 * Each store is a frozen object of four closures. Handlers receive it, so it has no fields a
 * handler could read or reassign (such as the tenant id or the shared record list).
 */
import type { Clock, TenantDataStore, TenantDataStoreFactory } from "../domain/ports.js";
import {
  checkCollectionName,
  checkFilter,
  checkFindLimit,
  checkRecordKeys,
  DataStoreUsageError,
  DEFAULT_FIND_LIMIT,
  matchesFilterValue,
} from "../domain/tenant-data.js";
import type { TenantContext } from "../domain/tenant.js";
import type { TenantRecord } from "../domain/tool.js";

export interface StoredTenantRecord {
  id: string;
  tenantId: string;
  collection: string;
  data: TenantRecord;
  createdAt: Date;
  updatedAt: Date;
}

const systemClock: Clock = { now: () => new Date() };

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Converts a cloned value the way the MongoDB driver stores it: `undefined` becomes `null`, a
 * `Map` with string keys becomes a plain object (other keys are rejected), a `Set` becomes `{}`.
 */
function asMongoStores(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(asMongoStores);
  if (value instanceof Set) return {};
  if (value instanceof Map) {
    const entries: [string, unknown][] = [];
    for (const [key, item] of value as Map<unknown, unknown>) {
      if (typeof key !== "string") throw new DataStoreUsageError("Map keys must be strings");
      entries.push([key, asMongoStores(item)]);
    }
    return Object.fromEntries(entries);
  }
  if (value !== null && typeof value === "object" && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asMongoStores(v)]));
  }
  return value;
}

/** A stored copy of a handler value. */
const toStored = (value: unknown): unknown => asMongoStores(structuredClone(value));

/** Runs `fn` so that a thrown error becomes a rejected promise, as with the MongoDB store. */
const settle = <T>(fn: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(fn());
  });

function createStore(
  records: StoredTenantRecord[],
  clock: Clock,
  nextId: () => string,
  tenantId: string,
): TenantDataStore {
  const select = (collection: string, filter: TenantRecord): StoredTenantRecord[] => {
    checkCollectionName(collection);
    const entries = checkFilter(filter);
    return records.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.collection === collection &&
        entries.every(([key, value]) => matchesFilterValue(r.data, key, value)),
    );
  };

  return Object.freeze({
    insert: (collection: string, doc: TenantRecord): Promise<{ id: string }> =>
      settle(() => {
        checkCollectionName(collection);
        checkRecordKeys("record", doc);
        const now = clock.now();
        const id = nextId();
        records.push({
          id,
          tenantId,
          collection,
          data: toStored(doc) as TenantRecord,
          createdAt: now,
          updatedAt: now,
        });
        return { id };
      }),

    findOne: (collection: string, filter: TenantRecord): Promise<TenantRecord | null> =>
      settle(() => {
        const [first] = select(collection, filter);
        return first === undefined ? null : structuredClone(first.data);
      }),

    find: (
      collection: string,
      filter: TenantRecord = {},
      limit = DEFAULT_FIND_LIMIT,
    ): Promise<TenantRecord[]> =>
      settle(() =>
        select(collection, filter)
          .slice(0, checkFindLimit(limit))
          .map((r) => structuredClone(r.data)),
      ),

    update: (collection: string, filter: TenantRecord, patch: TenantRecord): Promise<number> =>
      settle(() => {
        const keys = checkRecordKeys("patch", patch);
        const selected = select(collection, filter);
        const now = clock.now();
        for (const record of selected) {
          for (const key of keys) record.data[key] = toStored(patch[key]);
          record.updatedAt = now;
        }
        return selected.length;
      }),
  });
}

export class InMemoryTenantDataStoreFactory implements TenantDataStoreFactory {
  /** Every record of every tenant, in insertion order. Exposed for assertions; do not mutate. */
  readonly records: StoredTenantRecord[] = [];
  readonly #clock: Clock;
  #counter = 0;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  forTenant(ctx: TenantContext): TenantDataStore {
    return createStore(
      this.records,
      this.#clock,
      () => (++this.#counter).toString(16).padStart(24, "0"),
      ctx.tenantId,
    );
  }
}

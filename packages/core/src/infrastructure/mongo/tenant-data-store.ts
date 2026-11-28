/**
 * Persistence for tool handlers, backed by `tool_records`. Each store is bound to one tenant
 * when it is created; handlers cannot name a tenant (tenant-isolation rule 6). Validation
 * rules are shared with the in-memory fake (domain/tenant-data.ts).
 */
import type { Filter } from "mongodb";
import type { Clock, TenantDataStore, TenantDataStoreFactory } from "../../domain/ports.js";
import {
  checkCollectionName,
  checkFilter,
  checkFindLimit,
  checkRecordKeys,
  DEFAULT_FIND_LIMIT,
} from "../../domain/tenant-data.js";
import type { TenantContext } from "../../domain/tenant.js";
import type { TenantRecord } from "../../domain/tool.js";
import { toolRecordsOf, type MongoStore, type ToolRecordDoc } from "./collections.js";

export { DataStoreUsageError, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT } from "../../domain/tenant-data.js";

/**
 * A frozen object of four closures. Handlers receive it, so it has no fields a handler could
 * read or reassign (such as the tenant id or the MongoDB handle).
 */
function createStore(store: MongoStore, clock: Clock, tenantId: string): TenantDataStore {
  const records = () => toolRecordsOf(store);
  const scopedFilter = (collection: string, filter: TenantRecord): Filter<ToolRecordDoc> => {
    checkCollectionName(collection);
    const scoped: Filter<ToolRecordDoc> = { tenantId, collection };
    for (const [key, value] of checkFilter(filter)) scoped[`data.${key}`] = value;
    return scoped;
  };

  return Object.freeze({
    async insert(collection: string, doc: TenantRecord): Promise<{ id: string }> {
      checkCollectionName(collection);
      checkRecordKeys("record", doc);
      const now = clock.now();
      const result = await records().insertOne({
        tenantId,
        collection,
        data: structuredClone(doc),
        createdAt: now,
        updatedAt: now,
      });
      return { id: result.insertedId.toHexString() };
    },

    async findOne(collection: string, filter: TenantRecord): Promise<TenantRecord | null> {
      const doc = await records().findOne(scopedFilter(collection, filter), {
        sort: { createdAt: 1, _id: 1 },
      });
      return doc?.data ?? null;
    },

    async find(
      collection: string,
      filter: TenantRecord = {},
      limit = DEFAULT_FIND_LIMIT,
    ): Promise<TenantRecord[]> {
      const capped = checkFindLimit(limit);
      const docs = await records()
        .find(scopedFilter(collection, filter))
        .sort({ createdAt: 1, _id: 1 })
        .limit(capped)
        .toArray();
      return docs.map((doc) => doc.data);
    },

    async update(collection: string, filter: TenantRecord, patch: TenantRecord): Promise<number> {
      const set: Record<string, unknown> = { updatedAt: clock.now() };
      for (const key of checkRecordKeys("patch", patch)) set[`data.${key}`] = structuredClone(patch[key]);
      const result = await records().updateMany(scopedFilter(collection, filter), { $set: set });
      return result.matchedCount;
    },
  });
}

export class MongoTenantDataStoreFactory implements TenantDataStoreFactory {
  readonly #store: MongoStore;
  readonly #clock: Clock;

  constructor(store: MongoStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  forTenant(ctx: TenantContext): TenantDataStore {
    return createStore(this.#store, this.#clock, ctx.tenantId);
  }
}

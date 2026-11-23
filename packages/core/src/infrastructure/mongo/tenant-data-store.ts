/**
 * Persistence for tool handlers, backed by `tool_records`. Each store is bound to one tenant
 * when it is created; handlers cannot name a tenant (tenant-isolation rule 6).
 */
import type { Filter } from "mongodb";
import type { Clock, TenantDataStore, TenantDataStoreFactory } from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import type { TenantRecord } from "../../domain/tool.js";
import { toolRecordsOf, type MongoStore, type ToolRecordDoc } from "./collections.js";

const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export const DEFAULT_FIND_LIMIT = 100;
export const MAX_FIND_LIMIT = 1000;

export class DataStoreUsageError extends Error {
  override readonly name = "DataStoreUsageError";
}

function checkCollection(collection: string): void {
  if (!COLLECTION_NAME.test(collection)) {
    throw new DataStoreUsageError(`Invalid collection name "${collection}": use ${String(COLLECTION_NAME)}`);
  }
}

/**
 * Top-level keys map to `data.<key>`. Operator keys (`$or`, `$where`) and dotted keys are
 * rejected, so a filter or patch can only ever address fields of the record's own data.
 */
function checkKeys(kind: string, record: TenantRecord): string[] {
  const keys = Object.keys(record);
  for (const key of keys) {
    if (key === "" || key.startsWith("$") || key.includes(".")) {
      throw new DataStoreUsageError(
        `Invalid ${kind} key "${key}": keys must not be empty, start with "$", or contain "."`,
      );
    }
  }
  return keys;
}

class MongoTenantDataStore implements TenantDataStore {
  constructor(
    private readonly store: MongoStore,
    private readonly clock: Clock,
    private readonly tenantId: string,
  ) {}

  private filter(collection: string, filter: TenantRecord): Filter<ToolRecordDoc> {
    checkCollection(collection);
    const scoped: Filter<ToolRecordDoc> = { tenantId: this.tenantId, collection };
    for (const key of checkKeys("filter", filter)) {
      if (filter[key] !== undefined) scoped[`data.${key}`] = filter[key];
    }
    return scoped;
  }

  async insert(collection: string, doc: TenantRecord): Promise<{ id: string }> {
    checkCollection(collection);
    checkKeys("record", doc);
    const now = this.clock.now();
    const result = await toolRecordsOf(this.store).insertOne({
      tenantId: this.tenantId,
      collection,
      data: structuredClone(doc),
      createdAt: now,
      updatedAt: now,
    });
    return { id: result.insertedId.toHexString() };
  }

  async findOne(collection: string, filter: TenantRecord): Promise<TenantRecord | null> {
    const doc = await toolRecordsOf(this.store).findOne(this.filter(collection, filter), {
      sort: { createdAt: 1 },
    });
    return doc?.data ?? null;
  }

  async find(
    collection: string,
    filter: TenantRecord = {},
    limit = DEFAULT_FIND_LIMIT,
  ): Promise<TenantRecord[]> {
    if (!Number.isInteger(limit) || limit < 1)
      throw new DataStoreUsageError("limit must be a positive integer");
    const docs = await toolRecordsOf(this.store)
      .find(this.filter(collection, filter))
      .sort({ createdAt: 1, _id: 1 })
      .limit(Math.min(limit, MAX_FIND_LIMIT))
      .toArray();
    return docs.map((doc) => doc.data);
  }

  async update(collection: string, filter: TenantRecord, patch: TenantRecord): Promise<number> {
    const set: Record<string, unknown> = { updatedAt: this.clock.now() };
    for (const key of checkKeys("patch", patch)) set[`data.${key}`] = patch[key];
    const result = await toolRecordsOf(this.store).updateMany(this.filter(collection, filter), { $set: set });
    return result.modifiedCount;
  }
}

export class MongoTenantDataStoreFactory implements TenantDataStoreFactory {
  constructor(
    private readonly store: MongoStore,
    private readonly clock: Clock,
  ) {}

  forTenant(ctx: TenantContext): TenantDataStore {
    return new MongoTenantDataStore(this.store, this.clock, ctx.tenantId);
  }
}

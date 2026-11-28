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

class MongoTenantDataStore implements TenantDataStore {
  constructor(
    private readonly store: MongoStore,
    private readonly clock: Clock,
    private readonly tenantId: string,
  ) {}

  private filter(collection: string, filter: TenantRecord): Filter<ToolRecordDoc> {
    checkCollectionName(collection);
    const scoped: Filter<ToolRecordDoc> = { tenantId: this.tenantId, collection };
    for (const [key, value] of checkFilter(filter)) scoped[`data.${key}`] = value;
    return scoped;
  }

  async insert(collection: string, doc: TenantRecord): Promise<{ id: string }> {
    checkCollectionName(collection);
    checkRecordKeys("record", doc);
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
      sort: { createdAt: 1, _id: 1 },
    });
    return doc?.data ?? null;
  }

  async find(
    collection: string,
    filter: TenantRecord = {},
    limit = DEFAULT_FIND_LIMIT,
  ): Promise<TenantRecord[]> {
    const capped = checkFindLimit(limit);
    const docs = await toolRecordsOf(this.store)
      .find(this.filter(collection, filter))
      .sort({ createdAt: 1, _id: 1 })
      .limit(capped)
      .toArray();
    return docs.map((doc) => doc.data);
  }

  async update(collection: string, filter: TenantRecord, patch: TenantRecord): Promise<number> {
    const set: Record<string, unknown> = { updatedAt: this.clock.now() };
    for (const key of checkRecordKeys("patch", patch)) set[`data.${key}`] = structuredClone(patch[key]);
    const result = await toolRecordsOf(this.store).updateMany(this.filter(collection, filter), { $set: set });
    return result.matchedCount;
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

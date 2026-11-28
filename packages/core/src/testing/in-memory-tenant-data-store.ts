/**
 * In-memory TenantDataStore with the same scoping, validation, and matching rules as the
 * MongoDB store (domain/tenant-data.ts), for handler tests without a database.
 */
import type { Clock, TenantDataStore, TenantDataStoreFactory } from "../domain/ports.js";
import {
  checkCollectionName,
  checkFilter,
  checkFindLimit,
  checkRecordKeys,
  DEFAULT_FIND_LIMIT,
  matchesFilterValue,
  type FilterValue,
} from "../domain/tenant-data.js";
import type { TenantContext } from "../domain/tenant.js";
import type { TenantRecord } from "../domain/tool.js";

interface StoredRecord {
  id: string;
  tenantId: string;
  collection: string;
  data: TenantRecord;
  createdAt: Date;
  updatedAt: Date;
}

const systemClock: Clock = { now: () => new Date() };

/** Runs `fn` so that a thrown error becomes a rejected promise, as with the MongoDB store. */
const settle = <T>(fn: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(fn());
  });

const matches = (record: StoredRecord, filter: readonly [string, FilterValue][]): boolean =>
  filter.every(([key, value]) => matchesFilterValue(record.data[key], value));

class InMemoryTenantDataStore implements TenantDataStore {
  constructor(
    private readonly records: StoredRecord[],
    private readonly clock: Clock,
    private readonly nextId: () => string,
    private readonly tenantId: string,
  ) {}

  #select(collection: string, filter: TenantRecord): StoredRecord[] {
    checkCollectionName(collection);
    const entries = checkFilter(filter);
    return this.records.filter(
      (r) => r.tenantId === this.tenantId && r.collection === collection && matches(r, entries),
    );
  }

  insert(collection: string, doc: TenantRecord): Promise<{ id: string }> {
    return settle(() => this.#insert(collection, doc));
  }

  #insert(collection: string, doc: TenantRecord): { id: string } {
    checkCollectionName(collection);
    checkRecordKeys("record", doc);
    const now = this.clock.now();
    const id = this.nextId();
    this.records.push({
      id,
      tenantId: this.tenantId,
      collection,
      data: structuredClone(doc),
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  }

  findOne(collection: string, filter: TenantRecord): Promise<TenantRecord | null> {
    return settle(() => {
      const [first] = this.#select(collection, filter);
      return first === undefined ? null : structuredClone(first.data);
    });
  }

  find(collection: string, filter: TenantRecord = {}, limit = DEFAULT_FIND_LIMIT): Promise<TenantRecord[]> {
    return settle(() =>
      this.#select(collection, filter)
        .slice(0, checkFindLimit(limit))
        .map((r) => structuredClone(r.data)),
    );
  }

  update(collection: string, filter: TenantRecord, patch: TenantRecord): Promise<number> {
    return settle(() => this.#update(collection, filter, patch));
  }

  #update(collection: string, filter: TenantRecord, patch: TenantRecord): number {
    const keys = checkRecordKeys("patch", patch);
    const selected = this.#select(collection, filter);
    const now = this.clock.now();
    for (const record of selected) {
      for (const key of keys) record.data[key] = structuredClone(patch[key]);
      record.updatedAt = now;
    }
    return selected.length;
  }
}

export class InMemoryTenantDataStoreFactory implements TenantDataStoreFactory {
  /** Every record of every tenant, in insertion order. Exposed for assertions; do not mutate. */
  readonly records: StoredRecord[] = [];
  #counter = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  forTenant(ctx: TenantContext): TenantDataStore {
    return new InMemoryTenantDataStore(
      this.records,
      this.clock,
      () => (++this.#counter).toString(16).padStart(24, "0"),
      ctx.tenantId,
    );
  }
}

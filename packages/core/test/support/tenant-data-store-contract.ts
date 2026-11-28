/**
 * One set of TenantDataStore tests run against every implementation (the MongoDB store in
 * integration tests, the in-memory fake in unit tests), so the fake cannot drift from MongoDB
 * (rules in domain/tenant-data.ts).
 */
import { describe, expect, it } from "vitest";
import type { TenantDataStoreFactory } from "../../src/domain/ports.js";
import { DataStoreUsageError } from "../../src/domain/tenant-data.js";
import type { TenantContext } from "../../src/domain/tenant.js";
import type { TenantRecord } from "../../src/domain/tool.js";

export interface DataStoreContractSetup {
  factory: TenantDataStoreFactory;
  alpha: TenantContext;
  beta: TenantContext;
}

let counter = 0;
/** A fresh collection per test, so tests never see each other's records in a shared database. */
const freshCollection = () => `contract-${String(++counter)}`;

const names = (records: TenantRecord[]) => records.map((r) => r.name);

export function describeTenantDataStoreContract(label: string, setup: () => DataStoreContractSetup): void {
  describe(`${label}: TenantDataStore contract`, () => {
    it("inserts, finds in insertion order, and counts matched records on update", async () => {
      const data = setup().factory.forTenant(setup().alpha);
      const c = freshCollection();
      const { id } = await data.insert(c, { name: "a", status: "open" });
      await data.insert(c, { name: "b", status: "open" });

      expect(id).toMatch(/^[0-9a-f]{24}$/);
      expect(names(await data.find(c, { status: "open" }))).toEqual(["a", "b"]);
      expect(await data.find(c, {}, 1)).toHaveLength(1);
      expect(await data.findOne(c, { name: "b" })).toEqual({ name: "b", status: "open" });
      expect(await data.findOne(c, { name: "zzz" })).toBeNull();
      // Matched, not modified: setting the value a record already has still counts it.
      expect(await data.update(c, { status: "open" }, { status: "open" })).toBe(2);
      expect(await data.update(c, { name: "b" }, { status: "closed" })).toBe(1);
      expect(await data.findOne(c, { name: "b" })).toEqual({ name: "b", status: "closed" });
    });

    it("keeps tenants apart, even when a filter names a tenant", async () => {
      const { factory, alpha, beta } = setup();
      const c = freshCollection();
      await factory.forTenant(alpha).insert(c, { name: "a" });
      const other = factory.forTenant(beta);

      expect(await other.find(c)).toEqual([]);
      expect(await other.find(c, { tenantId: alpha.tenantId })).toEqual([]);
      expect(await other.update(c, { name: "a" }, { stolen: true })).toBe(0);
      expect(await factory.forTenant(alpha).findOne(c, { name: "a" })).toEqual({ name: "a" });
    });

    it("matches like MongoDB equality on scalars", async () => {
      const data = setup().factory.forTenant(setup().alpha);
      const c = freshCollection();
      await data.insert(c, { name: "tags", tags: ["red", "blue"] });
      await data.insert(c, { name: "null", note: null });
      await data.insert(c, { name: "missing" });
      await data.insert(c, { name: "null-in-array", note: [null, "x"] });
      await data.insert(c, { name: "empty-array", note: [] });
      await data.insert(c, { name: "nested", tags: [["blue"]] });

      expect(names(await data.find(c, { tags: "blue" }))).toEqual(["tags"]);
      expect(names(await data.find(c, { note: null }))).toEqual([
        "tags",
        "null",
        "missing",
        "null-in-array",
        "nested",
      ]);
      // Only own fields count: an inherited property such as `constructor` is a missing field.
      expect(await data.find(c, { constructor: null })).toHaveLength(6);
      expect(await data.find(c, { toString: "x" })).toEqual([]);
    });

    it("stores undefined values as null", async () => {
      const data = setup().factory.forTenant(setup().alpha);
      const c = freshCollection();
      await data.insert(c, { name: "u", a: undefined, list: [undefined, 1], nested: { b: undefined } });
      await data.update(c, { name: "u" }, { c: undefined });
      expect(await data.findOne(c, { name: "u" })).toEqual({
        name: "u",
        a: null,
        list: [null, 1],
        nested: { b: null },
        c: null,
      });
    });

    it("stores a Map with string keys as an object and a Set as an empty object, as MongoDB does", async () => {
      const data = setup().factory.forTenant(setup().alpha);
      const c = freshCollection();
      await data.insert(c, { name: "m", map: new Map([["a", new Map([["b", 1]])]]), set: new Set([1, 2]) });
      expect(await data.findOne(c, { name: "m" })).toEqual({ name: "m", map: { a: { b: 1 } }, set: {} });
      await expect(data.insert(c, { name: "bad", map: new Map([[1, "x"]]) })).rejects.toThrow();
      expect(await data.find(c, { name: "bad" })).toEqual([]);
    });

    it("stores and returns copies", async () => {
      const data = setup().factory.forTenant(setup().alpha);
      const c = freshCollection();
      const doc = { name: "n", nested: { n: 1 } };
      await data.insert(c, doc);
      doc.nested.n = 2;
      const found = await data.findOne(c, {});
      (found?.nested as { n: number }).n = 3;
      expect(await data.findOne(c, {})).toEqual({ name: "n", nested: { n: 1 } });
    });

    it("rejects bad collection names, unsafe keys, non-scalar filter values, and bad limits", async () => {
      const data = setup().factory.forTenant(setup().alpha);
      const c = freshCollection();
      const protoKey = JSON.parse('{"__proto__": {"polluted": true}}') as TenantRecord;
      const rejected = [
        data.insert("Bad Name", {}),
        data.insert(c, { "x.y": 1 }),
        data.insert(c, protoKey),
        data.find(c, { $where: "true" }),
        data.find(c, { "a.b": 1 }),
        data.find(c, protoKey),
        data.find(c, { tags: ["red"] }),
        data.find(c, { n: { $gt: 1 } }),
        data.find(c, { n: Number.NaN }),
        data.find(c, {}, 0),
        data.update(c, {}, { $set: { x: 1 } }),
        data.update(c, {}, protoKey),
      ];
      for (const attempt of rejected) await expect(attempt).rejects.toThrow(DataStoreUsageError);
      expect(await data.find(c)).toEqual([]);
    });

    it("exposes only its four operations, frozen", () => {
      const data = setup().factory.forTenant(setup().alpha);
      expect(Object.keys(data).sort()).toEqual(["find", "findOne", "insert", "update"]);
      expect(Object.getOwnPropertySymbols(data)).toEqual([]);
      expect(Object.isFrozen(data)).toBe(true);
      expect(Reflect.set(data, "tenantId", "someone-else")).toBe(false);
    });
  });
}

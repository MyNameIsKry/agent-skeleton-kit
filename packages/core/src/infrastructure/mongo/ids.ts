import { createHash } from "node:crypto";

// NUL separators keep ("a", "bc") and ("ab", "c") apart. Tenant ids and sources cannot contain NUL.
const sha256 = (...parts: (string | number)[]): string =>
  createHash("sha256").update(parts.map(String).join("\0")).digest("hex");

/** Deterministic document id. Includes the tenant, so equal sources in two tenants never collide. */
export const documentId = (tenantId: string, source: string): string => sha256("doc", tenantId, source);

/** Deterministic chunk id. Retried ingestion jobs therefore overwrite instead of duplicating. */
export const chunkId = (docId: string, version: number, idx: number): string =>
  sha256("chunk", docId, version, idx);

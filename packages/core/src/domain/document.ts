export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface DocumentRecord {
  id: string;
  tenantId: string;
  /** Path relative to the tenant's knowledge/ directory, for example "hr-policies.md". */
  source: string;
  contentHash: string;
  /** Version currently being produced or last produced. */
  version: number;
  /** Version that serves queries, or null before the first successful ingestion. */
  activeVersion: number | null;
  status: DocumentStatus;
  error?: string;
  chunkCount: number;
  updatedAt: Date;
}

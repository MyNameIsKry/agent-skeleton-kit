/** Knowledge files and their parsed form. See design.md section 6. */

/** File types ingested from a tenant's `knowledge/` directory. Others are skipped with a warning. */
export const KNOWLEDGE_EXTENSIONS = [".md", ".markdown", ".pdf"] as const;

/** Larger files are rejected: they are rarely knowledge documents and would stall a worker. */
export const MAX_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024;

export interface KnowledgeFile {
  /** POSIX path relative to `knowledge/`, for example "policies/leave.md". */
  source: string;
  /** sha256 of the file bytes, hex. */
  contentHash: string;
  sizeBytes: number;
}

export interface KnowledgeFileContent {
  bytes: Uint8Array;
  contentHash: string;
}

/** A contiguous piece of a document with its location, before chunking. */
export interface ParsedSection {
  /** Markdown heading path, outermost first. Empty for text before the first heading and for PDFs. */
  headingPath: readonly string[];
  /** 1-based PDF page number. */
  page?: number;
  text: string;
}

export interface ParsedDocument {
  sections: ParsedSection[];
}

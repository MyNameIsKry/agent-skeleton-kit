/**
 * Reads knowledge files from `<tenant rootDir>/knowledge/`. Sources are POSIX paths relative
 * to that directory. Every path, including symlinks, must resolve inside it after realpath:
 * a source in a queued job is untrusted input (tenant-isolation rules 5 and 7).
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { IngestError } from "../../domain/errors.js";
import {
  KNOWLEDGE_EXTENSIONS,
  MAX_KNOWLEDGE_FILE_BYTES,
  type KnowledgeFile,
  type KnowledgeFileContent,
} from "../../domain/knowledge.js";
import type { KnowledgeSource, Logger } from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import { isInside } from "../config/handler-loader.js";

export const KNOWLEDGE_DIR = "knowledge";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const isSupported = (source: string): boolean =>
  (KNOWLEDGE_EXTENSIONS as readonly string[]).includes(path.posix.extname(source).toLowerCase());

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** Rejects sources that could name a path outside `knowledge/` before touching the disk. */
function checkSourceSyntax(source: string): void {
  if (source === "" || source.includes("\0")) throw new IngestError("Invalid knowledge source path", false);
  if (path.posix.isAbsolute(source) || path.win32.isAbsolute(source) || source.includes("\\")) {
    throw new IngestError(`Knowledge source "${source}" must be a relative POSIX path`, false);
  }
  if (source.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new IngestError(`Knowledge source "${source}" must not contain empty, "." or ".." segments`, false);
  }
}

export interface FsKnowledgeSourceOptions {
  logger?: Logger;
  maxFileBytes?: number;
}

export class FsKnowledgeSource implements KnowledgeSource {
  readonly #logger: Logger | undefined;
  readonly #maxFileBytes: number;

  constructor(options: FsKnowledgeSourceOptions = {}) {
    this.#logger = options.logger;
    this.#maxFileBytes = options.maxFileBytes ?? MAX_KNOWLEDGE_FILE_BYTES;
  }

  /** Realpath of the tenant's knowledge directory, or null if it does not exist. */
  async #root(ctx: TenantContext): Promise<string | null> {
    try {
      const root = await realpath(path.join(ctx.config.rootDir, KNOWLEDGE_DIR));
      return (await stat(root)).isDirectory() ? root : null;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async list(ctx: TenantContext): Promise<KnowledgeFile[]> {
    const root = await this.#root(ctx);
    if (root === null) return [];
    const files: KnowledgeFile[] = [];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries: Dirent[] = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const source = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const absolute = path.join(dir, entry.name);

        let real: string;
        try {
          real = await realpath(absolute);
        } catch (error) {
          this.#logger?.warn(
            { tenantId: ctx.tenantId, source, code: errorCode(error) },
            "Skipping unreadable knowledge path",
          );
          continue;
        }
        if (!isInside(root, real)) {
          this.#logger?.warn(
            { tenantId: ctx.tenantId, source },
            "Skipping knowledge path that resolves outside knowledge/",
          );
          continue;
        }
        const info = await stat(real);
        if (info.isDirectory()) {
          await walk(absolute, source);
        } else if (!info.isFile()) {
          continue;
        } else if (!isSupported(source)) {
          this.#logger?.warn({ tenantId: ctx.tenantId, source }, "Skipping unsupported knowledge file type");
        } else if (info.size > this.#maxFileBytes) {
          this.#logger?.warn(
            { tenantId: ctx.tenantId, source, sizeBytes: info.size, maxBytes: this.#maxFileBytes },
            "Skipping knowledge file that is too large",
          );
        } else {
          files.push({ source, contentHash: sha256(await readFile(real)), sizeBytes: info.size });
        }
      }
    };

    await walk(root, "");
    return files;
  }

  async read(ctx: TenantContext, source: string): Promise<KnowledgeFileContent> {
    checkSourceSyntax(source);
    if (!isSupported(source)) throw new IngestError(`${source} has an unsupported file type`, false);

    const root = await this.#root(ctx);
    if (root === null) throw new IngestError(`The tenant has no ${KNOWLEDGE_DIR}/ directory`, false);

    let real: string;
    try {
      real = await realpath(path.join(root, ...source.split("/")));
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        throw new IngestError(`${source} no longer exists`, false, { cause: error });
      }
      throw new IngestError(`${source} cannot be read`, true, { cause: error });
    }
    if (!isInside(root, real)) throw new IngestError(`${source} resolves outside ${KNOWLEDGE_DIR}/`, false);

    const info = await stat(real);
    if (!info.isFile()) throw new IngestError(`${source} is not a file`, false);
    if (info.size > this.#maxFileBytes) {
      throw new IngestError(`${source} is larger than ${this.#maxFileBytes} bytes`, false);
    }
    const bytes = new Uint8Array(await readFile(real));
    return { bytes, contentHash: sha256(bytes) };
  }
}

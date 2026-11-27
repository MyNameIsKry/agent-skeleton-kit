/**
 * Reads knowledge files from `<tenant rootDir>/knowledge/`. Sources are POSIX paths relative
 * to that directory. Every path, including symlinks, must resolve inside it after realpath:
 * a source in a queued job is untrusted input (tenant-isolation rules 5 and 7).
 *
 * Listing never skips an entry it merely failed to read: sync treats a missing entry as a
 * deleted file, so an I/O or permission error fails the listing instead.
 */
import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { IngestError, InfrastructureUnavailableError } from "../../domain/errors.js";
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

/** The entry is gone (deleted, or a dangling symlink): it really is not there. */
const isGone = (error: unknown): boolean => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";

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

class FileTooLargeError extends Error {}

/**
 * Opens `realPath` without following a final symlink, checks it is the same file that was
 * checked (`expected`), and reads at most `maxBytes`. Closes the race between the path check
 * and the read: a component swapped for a symlink in between fails instead of being followed.
 */
async function readChecked(realPath: string, expected: Stats, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev) {
      throw new IngestError("The file changed while it was being read. Run ingest again.", false);
    }
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) throw new FileTooLargeError();
      if (length === buffer.length) break;
    }
    return new Uint8Array(buffer.subarray(0, length));
  } finally {
    await handle.close();
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
      if (isGone(error)) return null;
      throw this.#unreadable(ctx, KNOWLEDGE_DIR, error);
    }
  }

  #unreadable(ctx: TenantContext, source: string, error: unknown): InfrastructureUnavailableError {
    return new InfrastructureUnavailableError(
      `Knowledge of tenant ${ctx.tenantId} cannot be read: ${source} (${errorCode(error) ?? "unknown error"}). ` +
        "Nothing was changed; fix the file permissions and sync again.",
      { cause: error },
    );
  }

  async list(ctx: TenantContext): Promise<KnowledgeFile[]> {
    const root = await this.#root(ctx);
    if (root === null) return [];
    const files: KnowledgeFile[] = [];
    // Realpaths of directories already walked: a symlink loop is listed once, not until the
    // kernel's symlink limit stops it.
    const visited = new Set<string>([root]);

    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        throw this.#unreadable(ctx, prefix === "" ? KNOWLEDGE_DIR : prefix, error);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const source = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const absolute = path.join(dir, entry.name);

        let real: string;
        let info: Stats;
        try {
          real = await realpath(absolute);
          info = await stat(real);
        } catch (error) {
          if (isGone(error)) {
            // Deleted while listing, or a dangling symlink: there is no file, so sync may drop it.
            this.#logger?.warn(
              { tenantId: ctx.tenantId, source },
              "Skipping knowledge path that does not exist",
            );
            continue;
          }
          throw this.#unreadable(ctx, source, error);
        }
        if (!isInside(root, real)) {
          this.#logger?.warn(
            { tenantId: ctx.tenantId, source },
            "Skipping knowledge path that resolves outside knowledge/",
          );
          continue;
        }
        if (info.isDirectory()) {
          if (visited.has(real)) {
            this.#logger?.warn(
              { tenantId: ctx.tenantId, source },
              "Skipping knowledge directory that was already listed",
            );
            continue;
          }
          visited.add(real);
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
          let bytes: Uint8Array;
          try {
            bytes = await readChecked(real, info, this.#maxFileBytes);
          } catch (error) {
            if (isGone(error)) continue;
            if (error instanceof FileTooLargeError || error instanceof IngestError) {
              // Grew or changed between stat and read; the next sync sees its final state.
              this.#logger?.warn(
                { tenantId: ctx.tenantId, source },
                "Skipping knowledge file that changed while listing",
              );
              continue;
            }
            throw this.#unreadable(ctx, source, error);
          }
          files.push({ source, contentHash: sha256(bytes), sizeBytes: bytes.length });
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
    let info: Stats;
    try {
      real = await realpath(path.join(root, ...source.split("/")));
      info = await stat(real);
    } catch (error) {
      if (isGone(error)) throw new IngestError(`${source} no longer exists`, false, { cause: error });
      throw new IngestError(`${source} cannot be read`, true, { cause: error });
    }
    if (!isInside(root, real)) throw new IngestError(`${source} resolves outside ${KNOWLEDGE_DIR}/`, false);
    if (!info.isFile()) throw new IngestError(`${source} is not a file`, false);
    if (info.size > this.#maxFileBytes) {
      throw new IngestError(`${source} is larger than ${this.#maxFileBytes} bytes`, false);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readChecked(real, info, this.#maxFileBytes);
    } catch (error) {
      if (error instanceof IngestError) throw error;
      if (error instanceof FileTooLargeError) {
        throw new IngestError(`${source} is larger than ${this.#maxFileBytes} bytes`, false);
      }
      if (errorCode(error) === "ELOOP") {
        throw new IngestError(`${source} changed while it was being read. Run ingest again.`, false, {
          cause: error,
        });
      }
      if (isGone(error)) throw new IngestError(`${source} no longer exists`, false, { cause: error });
      throw new IngestError(`${source} cannot be read`, true, { cause: error });
    }
    return { bytes, contentHash: sha256(bytes) };
  }
}

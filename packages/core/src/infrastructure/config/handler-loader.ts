/**
 * Resolves and imports tenant tool handlers. Enforces path containment: a handler must be a
 * regular file inside the tenant directory after symlinks are resolved
 * (.kiro/steering/tenant-isolation.md, rule 7).
 *
 * Containment is a path check, not a sandbox: handler code runs in-process with the core's
 * privileges and can import any module it likes. Only run tenant code you trust.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolHandler } from "../../domain/tool.js";

/** Order matters: compiled `.js` wins over `.ts` source in production images. */
const EXTENSIONS = ["", ".js", ".mjs", ".ts"] as const;

export class HandlerLoadError extends Error {
  override readonly name = "HandlerLoadError";
}

export interface LoadedHandler {
  path: string;
  handler: ToolHandler;
}

/** True when `candidate` is strictly inside `root`. Names that merely start with ".." are inside. */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "" || path.isAbsolute(relative)) return false;
  const [first] = relative.split(path.sep);
  return first !== "..";
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** realpath that maps "no such file" to null and every other failure to a HandlerLoadError. */
async function realpathOrNull(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (error) {
    const code = errorCode(error);
    // ENOTDIR: a path segment is a file, for example "./tools/ok.js/x".
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "ELOOP") throw new HandlerLoadError("is part of a symlink loop", { cause: error });
    throw new HandlerLoadError(`cannot be read (${code ?? "unknown error"})`, { cause: error });
  }
}

/**
 * @param tenantRoot Tenant directory (any form; it is realpath'd here).
 * @param configured The `handler` value from tenant.yaml, for example "./tools/lookup".
 * @returns The absolute, symlink-resolved path of the handler file.
 */
export async function resolveHandlerPath(tenantRoot: string, configured: string): Promise<string> {
  if (configured.includes("\0")) {
    throw new HandlerLoadError("must not contain NUL characters");
  }
  if (path.isAbsolute(configured) || path.win32.isAbsolute(configured)) {
    throw new HandlerLoadError("must be a relative path inside the tenant directory");
  }
  if (configured.split(/[\\/]/).includes("..")) {
    throw new HandlerLoadError("must not contain '..' segments");
  }

  const root = await realpath(tenantRoot);
  const tried: string[] = [];

  // Fail closed: if any candidate resolves outside the tenant, the whole handler is rejected,
  // even when a later candidate would have been a valid file inside.
  for (const extension of EXTENSIONS) {
    const candidate = path.resolve(root, configured + extension);
    tried.push(path.relative(root, candidate));
    const real = await realpathOrNull(candidate);
    if (real === null) continue;
    if (!isInside(root, real)) {
      throw new HandlerLoadError("resolves outside the tenant directory");
    }
    if ((await stat(real)).isFile()) return real;
  }

  throw new HandlerLoadError(`file not found (tried ${tried.join(", ")})`);
}

/** Resolves, imports, and checks the default export. Importing runs tenant code. */
export async function loadHandler(tenantRoot: string, configured: string): Promise<LoadedHandler> {
  const resolved = await resolveHandlerPath(tenantRoot, configured);

  let module: unknown;
  try {
    module = await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new HandlerLoadError(
      `failed to import: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  const handler = (module as { default?: unknown }).default;
  if (typeof handler !== "function") {
    throw new HandlerLoadError("must default-export a function");
  }
  return { path: resolved, handler: handler as ToolHandler };
}

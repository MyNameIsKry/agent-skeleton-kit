/**
 * Resolves and imports tenant tool handlers. Enforces path containment: a handler must be a
 * regular file inside the tenant directory after symlinks are resolved
 * (.kiro/steering/tenant-isolation.md, rule 7).
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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function realpathOrNull(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * @param tenantRoot Tenant directory (any form; it is realpath'd here).
 * @param configured The `handler` value from tenant.yaml, for example "./tools/lookup".
 * @returns The absolute, symlink-resolved path of the handler file.
 */
export async function resolveHandlerPath(tenantRoot: string, configured: string): Promise<string> {
  if (path.isAbsolute(configured) || path.win32.isAbsolute(configured)) {
    throw new HandlerLoadError("must be a relative path inside the tenant directory");
  }
  if (configured.split(/[\\/]/).includes("..")) {
    throw new HandlerLoadError("must not contain '..' segments");
  }

  const root = await realpath(tenantRoot);
  const tried: string[] = [];

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

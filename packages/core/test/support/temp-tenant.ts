import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TempTool {
  name: string;
  handler: string;
  /** Inline YAML flow mapping for `parameters`. */
  parameters?: string;
}

export const CLOSED_SCHEMA = "{ type: object, additionalProperties: false, properties: {} }";

/** Writes a minimal tenant.yaml with the given tools into `<root>/<id>`. */
export async function writeTenant(root: string, id: string, tools: readonly TempTool[]): Promise<string> {
  const dir = path.join(root, id);
  await mkdir(path.join(dir, "tools"), { recursive: true });
  const lines = [
    `id: ${id}`,
    "displayName: Temporary tenant",
    "description: Created by a test.",
    "systemPrompt: Test.",
    "tools:",
    ...tools.flatMap((tool) => [
      `  - name: ${tool.name}`,
      "    description: Test tool.",
      `    handler: ${JSON.stringify(tool.handler)}`,
      `    parameters: ${tool.parameters ?? CLOSED_SCHEMA}`,
    ]),
  ];
  if (tools.length === 0) lines.splice(lines.indexOf("tools:"), 1);
  await writeFile(path.join(dir, "tenant.yaml"), `${lines.join("\n")}\n`);
  return dir;
}

export const OK_HANDLER = "export default async () => ({ ok: true });\n";

/** Temporary directories that are removed by `cleanup()`. */
export class TempDirs {
  readonly #dirs: string[] = [];

  async make(prefix = "tenants-"): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.#dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

/**
 * Splits Markdown into sections at ATX headings (`#` to `######`) and records the heading path
 * of each section. Lines inside fenced code blocks are never treated as headings.
 */
import { parse as parseYaml } from "yaml";
import type { ParsedDocument, ParsedSection } from "../../domain/knowledge.js";

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/** CommonMark: a closing fence has no info string, only optional trailing spaces. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const FRONT_MATTER_DELIMITER = /^---[ \t]*$/;

/** Removes common inline Markdown from a heading so citations read naturally. */
function plainHeading(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .trim();
}

/**
 * Drops a leading YAML front matter block (`---` ... `---`) only when its body parses as a
 * YAML mapping. A document that merely starts with a `---` thematic break keeps its content.
 */
function stripFrontMatter(lines: string[]): string[] {
  if (lines.length === 0 || !FRONT_MATTER_DELIMITER.test(lines[0] ?? "")) return lines;
  const end = lines.findIndex((line, i) => i > 0 && FRONT_MATTER_DELIMITER.test(line));
  if (end === -1) return lines;
  let body: unknown;
  try {
    body = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    return lines;
  }
  const isMapping = body !== null && typeof body === "object" && !Array.isArray(body);
  return isMapping ? lines.slice(end + 1) : lines;
}

export function parseMarkdown(text: string): ParsedDocument {
  const lines = stripFrontMatter(
    text
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .split("\n"),
  );
  const sections: ParsedSection[] = [];
  /** headingStack[level - 1] is the current heading at that level. */
  const headingStack: string[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body !== "") sections.push({ headingPath: [...headingStack.filter(Boolean)], text: body });
    buffer = [];
  };

  for (const line of lines) {
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open?.[1] !== undefined) {
        fence = open[1];
        buffer.push(line);
        continue;
      }
    } else {
      const close = FENCE_CLOSE.exec(line);
      const marker = close?.[1];
      if (marker?.startsWith(fence.charAt(0)) === true && marker.length >= fence.length) fence = null;
      buffer.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flush();
      const level = heading[1].length;
      headingStack.length = level - 1;
      headingStack[level - 1] = plainHeading(heading[2]);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return { sections };
}

/**
 * Splits Markdown into sections at ATX headings (`#` to `######`) and records the heading path
 * of each section. Lines inside fenced code blocks are never treated as headings.
 */
import type { ParsedDocument, ParsedSection } from "../../domain/knowledge.js";

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FRONT_MATTER_DELIMITER = /^---[ \t]*$/;

/** Removes common inline Markdown from a heading so citations read naturally. */
function plainHeading(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .trim();
}

/** Drops a leading YAML front matter block (`---` ... `---`). */
function stripFrontMatter(lines: string[]): string[] {
  if (lines.length === 0 || !FRONT_MATTER_DELIMITER.test(lines[0] ?? "")) return lines;
  const end = lines.findIndex((line, i) => i > 0 && FRONT_MATTER_DELIMITER.test(line));
  return end === -1 ? lines : lines.slice(end + 1);
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
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence.charAt(0)) && marker.length >= fence.length) fence = null;
      buffer.push(line);
      continue;
    }
    if (fence === null) {
      const heading = HEADING.exec(line);
      if (heading?.[1] !== undefined && heading[2] !== undefined) {
        flush();
        const level = heading[1].length;
        headingStack.length = level - 1;
        headingStack[level - 1] = plainHeading(heading[2]);
        continue;
      }
    }
    buffer.push(line);
  }
  flush();
  return { sections };
}

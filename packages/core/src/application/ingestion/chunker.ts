/**
 * Splits parsed sections into chunks (design.md section 6).
 *
 * - Sizes are approximate tokens: 1 token is about 4 characters.
 * - Paragraphs (separated by blank lines) are packed into a chunk until the next one would
 *   exceed `maxTokens`.
 * - A paragraph too large on its own is split at word boundaries into pieces that leave room
 *   for the overlap, so consecutive pieces of the same paragraph always overlap. Line breaks
 *   inside the paragraph are kept. A single word longer than a piece is cut.
 * - Each chunk after the first in a section starts with the last `overlap` tokens of the
 *   previous chunk, cut at a word boundary, when that still fits.
 * - Chunks never span sections, so each keeps one heading path or page.
 *
 * Pure and deterministic: the same input always yields the same chunks.
 */
import type { ParsedSection } from "../../domain/knowledge.js";
import type { ChunkingSettings } from "../../domain/tenant.js";

export const CHARS_PER_TOKEN = 4;

export interface TextChunk {
  text: string;
  headingPath: readonly string[];
  page?: number;
}

/** A packing unit. `separator` joins it to the previous unit in the same chunk. */
interface Unit {
  text: string;
  separator: "\n\n" | " " | "\n";
}

/** Largest piece of a split paragraph, leaving room for the overlap and one separator. */
export function pieceLimit(maxChars: number, overlapChars: number): number {
  return overlapChars === 0 ? maxChars : Math.max(1, maxChars - overlapChars - 1);
}

/**
 * Splits text longer than `limit` at whitespace, keeping line breaks. Each piece carries the
 * separator that preceded its first word ("\n\n" for the first piece of the paragraph).
 */
function splitLong(text: string, limit: number): Unit[] {
  const units: Unit[] = [];
  let current = "";
  let currentSeparator: Unit["separator"] = "\n\n";

  for (const match of text.matchAll(/(\s*)(\S+)/g)) {
    const whitespace = match[1] ?? "";
    const word = match[2] ?? "";
    const before: Unit["separator"] =
      units.length === 0 && current === "" ? "\n\n" : whitespace.includes("\n") ? "\n" : " ";

    if (word.length > limit) {
      if (current !== "") units.push({ text: current, separator: currentSeparator });
      current = "";
      for (let i = 0; i < word.length; i += limit) {
        units.push({ text: word.slice(i, i + limit), separator: i === 0 ? before : " " });
      }
      continue;
    }
    if (current === "") {
      current = word;
      currentSeparator = before;
      continue;
    }
    const candidate = `${current}${before}${word}`;
    if (candidate.length > limit) {
      units.push({ text: current, separator: currentSeparator });
      current = word;
      currentSeparator = before;
    } else {
      current = candidate;
    }
  }
  if (current !== "") units.push({ text: current, separator: currentSeparator });
  return units;
}

/** The last `maxChars` characters of `text`, starting at a word boundary. */
function tail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const slice = text.slice(text.length - maxChars);
  const boundary = slice.search(/\s/);
  return boundary === -1 ? "" : slice.slice(boundary).trimStart();
}

function chunkSection(section: ParsedSection, maxChars: number, overlapChars: number): string[] {
  const limit = pieceLimit(maxChars, overlapChars);
  const units: Unit[] = section.text
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .flatMap((p) => (p.length > maxChars ? splitLong(p, limit) : [{ text: p, separator: "\n\n" as const }]));

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current === "" ? unit.text : `${current}${unit.separator}${unit.text}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    chunks.push(current);
    // Carry overlap only if the next chunk still fits; otherwise start clean.
    const overlap = tail(current, overlapChars);
    const withOverlap = `${overlap}${unit.separator}${unit.text}`;
    current = overlap !== "" && withOverlap.length <= maxChars ? withOverlap : unit.text;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

export function chunkSections(sections: readonly ParsedSection[], settings: ChunkingSettings): TextChunk[] {
  const maxChars = settings.maxTokens * CHARS_PER_TOKEN;
  const overlapChars = settings.overlap * CHARS_PER_TOKEN;
  const chunks: TextChunk[] = [];
  for (const section of sections) {
    for (const text of chunkSection(section, maxChars, overlapChars)) {
      const chunk: TextChunk = { text, headingPath: section.headingPath };
      if (section.page !== undefined) chunk.page = section.page;
      chunks.push(chunk);
    }
  }
  return chunks;
}

/** Text sent to the embedding model: the heading path gives the chunk its context. */
export function embeddingInput(chunk: TextChunk): string {
  return chunk.headingPath.length === 0 ? chunk.text : `${chunk.headingPath.join(" > ")}\n\n${chunk.text}`;
}

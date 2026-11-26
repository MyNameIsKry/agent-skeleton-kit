/**
 * Splits parsed sections into chunks (design.md section 6).
 *
 * - Sizes are approximate tokens: 1 token is about 4 characters.
 * - Paragraphs are packed into a chunk until the next one would exceed `maxTokens`.
 * - A paragraph that is too large on its own is split at word boundaries; a single word longer
 *   than the limit is cut.
 * - Each chunk after the first in a section starts with the last `overlap` tokens of the
 *   previous chunk, cut at a word boundary, so context carries across the cut.
 * - Chunks never span sections, so each keeps one heading path or page.
 *
 * Pure and deterministic: the same input always yields the same chunks.
 */
import type { ChunkingSettings } from "../../domain/tenant.js";
import type { ParsedSection } from "../../domain/knowledge.js";

export const CHARS_PER_TOKEN = 4;

export interface TextChunk {
  text: string;
  headingPath: readonly string[];
  page?: number;
}

const wordsOf = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");

/** Splits text that is longer than `maxChars` into pieces at word boundaries. */
function splitLong(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of wordsOf(text)) {
    if (word.length > maxChars) {
      if (current !== "") pieces.push(current);
      current = "";
      for (let i = 0; i < word.length; i += maxChars) pieces.push(word.slice(i, i + maxChars));
      continue;
    }
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > maxChars) {
      pieces.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
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
  const paragraphs = section.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .flatMap((p) => (p.length > maxChars ? splitLong(p, maxChars) : [p]));

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    chunks.push(current);
    // Carry overlap only if the next chunk still fits; otherwise start clean.
    const overlap = tail(current, overlapChars);
    current =
      overlap !== "" && overlap.length + 2 + paragraph.length <= maxChars
        ? `${overlap}\n\n${paragraph}`
        : paragraph;
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

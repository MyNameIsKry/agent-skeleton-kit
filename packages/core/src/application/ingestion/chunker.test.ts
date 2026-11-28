import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ParsedSection } from "../../domain/knowledge.js";
import { CHARS_PER_TOKEN, chunkSections, embeddingInput, pieceLimit } from "./chunker.js";

const section = (text: string, headingPath: string[] = ["Doc"]): ParsedSection => ({ headingPath, text });

describe("chunkSections", () => {
  it("keeps a small section in one chunk with its heading path", () => {
    expect(chunkSections([section("Short text.")], { maxTokens: 50, overlap: 10 })).toEqual([
      { text: "Short text.", headingPath: ["Doc"] },
    ]);
  });

  it("packs paragraphs up to the limit and carries overlap into the next chunk", () => {
    // maxTokens 10 => 40 characters, overlap 3 => 12 characters.
    const text = ["aaaa bbbb cccc", "dddd eeee ffff", "gggg hhhh iiii"].join("\n\n");
    const chunks = chunkSections([section(text)], { maxTokens: 10, overlap: 3 });
    expect(chunks.map((c) => c.text)).toEqual([
      "aaaa bbbb cccc\n\ndddd eeee ffff",
      "eeee ffff\n\ngggg hhhh iiii",
    ]);
  });

  it("splits an oversized paragraph at word boundaries and cuts a single huge word", () => {
    const chunks = chunkSections([section(`one two three ${"x".repeat(25)}`)], { maxTokens: 3, overlap: 0 });
    expect(chunks.map((c) => c.text)).toEqual(["one two", "three", "xxxxxxxxxxxx", "xxxxxxxxxxxx", "x"]);
  });

  it("overlaps consecutive pieces of one long paragraph", () => {
    const words = Array.from({ length: 300 }, (_, i) => `w${String(i)}`);
    const chunks = chunkSections([section(words.join(" "))], { maxTokens: 50, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const previousWords = chunks[i - 1]!.text.split(/\s+/);
      const firstWord = chunks[i]!.text.split(/\s+/)[0]!;
      // The next chunk starts inside the previous one, so the cut is covered by both.
      expect(previousWords.slice(-12)).toContain(firstWord);
      expect(chunks[i]!.text.length).toBeLessThanOrEqual(200);
    }
  });

  it("keeps line breaks inside a long paragraph, as in PDF page text", () => {
    const page = "line one is here\nline two is here\nline three is here\nline four is here";
    const chunks = chunkSections([{ headingPath: [], page: 1, text: page }], { maxTokens: 10, overlap: 2 });
    expect(chunks.map((c) => c.text)).toEqual([
      "line one is here\nline two is",
      "two is here\nline three is here\nline",
      "line four is here",
    ]);
  });

  it("never merges sections and keeps PDF page numbers", () => {
    const chunks = chunkSections(
      [
        { headingPath: [], page: 1, text: "Page one." },
        { headingPath: [], page: 2, text: "Page two." },
      ],
      { maxTokens: 100, overlap: 10 },
    );
    expect(chunks).toEqual([
      { text: "Page one.", headingPath: [], page: 1 },
      { text: "Page two.", headingPath: [], page: 2 },
    ]);
  });

  it("prefixes the heading path only in the embedding input", () => {
    const [chunk] = chunkSections([section("Body.", ["Handbook", "Leave"])], { maxTokens: 50, overlap: 0 });
    expect(chunk?.text).toBe("Body.");
    expect(embeddingInput(chunk!)).toBe("Handbook > Leave\n\nBody.");
    expect(embeddingInput({ text: "Page text.", headingPath: [], page: 3 })).toBe("Page text.");
  });
});

// --- Properties (design.md P5 and testing.md) ------------------------------------------

const word = fc.stringMatching(/^[a-z0-9]{1,30}$/);
const paragraph = fc.array(word, { minLength: 1, maxLength: 40 }).map((words) => words.join(" "));
const sectionText = fc.array(paragraph, { minLength: 1, maxLength: 12 }).map((ps) => ps.join("\n\n"));
const settings = fc
  .record({ maxTokens: fc.integer({ min: 2, max: 120 }), overlap: fc.integer({ min: 0, max: 60 }) })
  .filter((s) => s.overlap < s.maxTokens);

describe("chunkSections properties", () => {
  it("never exceeds the size limit", () => {
    fc.assert(
      fc.property(sectionText, settings, (text, s) => {
        const maxChars = s.maxTokens * CHARS_PER_TOKEN;
        return chunkSections([section(text)], s).every((chunk) => chunk.text.length <= maxChars);
      }),
    );
  });

  it("covers every word of the input, in order", () => {
    fc.assert(
      fc.property(sectionText, settings, (text, s) => {
        const maxChars = s.maxTokens * CHARS_PER_TOKEN;
        const limit = pieceLimit(maxChars, s.overlap * CHARS_PER_TOKEN);
        // In a paragraph longer than the limit, words longer than a piece are cut into pieces.
        const cut = (w: string) =>
          w.length <= limit ? [w] : (w.match(new RegExp(`.{1,${String(limit)}}`, "g")) ?? []);
        const expected = text.split("\n\n").flatMap((p) => {
          const words = p.split(/\s+/).filter(Boolean);
          return p.length <= maxChars ? words : words.flatMap(cut);
        });
        const seen: string[] = [];
        for (const chunk of chunkSections([section(text)], s)) {
          for (const w of chunk.text.split(/\s+/).filter(Boolean)) {
            // Overlap repeats words that are already covered; skip them.
            if (seen.length < expected.length && w === expected[seen.length]) seen.push(w);
          }
        }
        expect(seen).toEqual(expected);
      }),
    );
  });

  it("is deterministic, so chunk ids derived from (docId, version, idx) are stable", () => {
    fc.assert(
      fc.property(fc.array(sectionText, { minLength: 1, maxLength: 4 }), settings, (texts, s) => {
        const sections = texts.map((t, i) => section(t, [`Heading ${String(i)}`]));
        expect(chunkSections(sections, s)).toEqual(chunkSections(sections, s));
      }),
    );
  });

  it("never produces empty chunks", () => {
    fc.assert(
      fc.property(fc.string(), settings, (text, s) =>
        chunkSections([section(text)], s).every((c) => c.text.trim() !== ""),
      ),
    );
  });
});

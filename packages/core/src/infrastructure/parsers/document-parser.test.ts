import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../test/support/fixture-paths.js";
import { IngestError } from "../../domain/errors.js";
import { ExtensionDocumentParser } from "./document-parser.js";

const parser = new ExtensionDocumentParser();

async function ingestError(promise: Promise<unknown>): Promise<IngestError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IngestError);
  expect((error as IngestError).retryable).toBe(false);
  return error as IngestError;
}

describe("ExtensionDocumentParser", () => {
  it("extracts PDF text per page with page numbers", async () => {
    const bytes = new Uint8Array(
      await readFile(path.join(FIXTURES.alpha, "knowledge", "onboarding-checklist.pdf")),
    );
    const { sections } = await parser.parse("onboarding-checklist.pdf", bytes);
    expect(sections).toEqual([
      {
        headingPath: [],
        page: 1,
        text: "Alpha onboarding checklist\nDay one: collect your laptop from the IT desk.\nDay one: enable two-factor authentication.",
      },
      { headingPath: [], page: 2, text: "Week one\nMeet your onboarding buddy and read the alpha handbook." },
    ]);
  });

  it("parses Markdown by extension, case-insensitively", async () => {
    const bytes = new TextEncoder().encode("# Title\nBody");
    expect((await parser.parse("guide.MD", bytes)).sections).toEqual([
      { headingPath: ["Title"], text: "Body" },
    ]);
    expect((await parser.parse("guide.markdown", bytes)).sections).toHaveLength(1);
  });

  it("rejects a PDF that cannot be read", async () => {
    const error = await ingestError(parser.parse("broken.pdf", new TextEncoder().encode("not a pdf")));
    expect(error.message).toBe("broken.pdf is not a readable PDF");
  });

  it("rejects Markdown that is not valid UTF-8", async () => {
    const error = await ingestError(parser.parse("latin1.md", new Uint8Array([0x43, 0x61, 0x66, 0xe9])));
    expect(error.message).toBe("latin1.md is not valid UTF-8 text");
  });

  it("rejects unsupported file types", async () => {
    const error = await ingestError(parser.parse("notes.txt", new Uint8Array()));
    expect(error.message).toBe('notes.txt has an unsupported file type ".txt"');
  });
});

/** Extracts text per page with unpdf (pdf.js). Scanned PDFs without a text layer yield no sections. */
import { extractText, getDocumentProxy } from "unpdf";
import type { ParsedDocument, ParsedSection } from "../../domain/knowledge.js";

export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  // pdf.js may detach the buffer it is given, so it gets a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const sections: ParsedSection[] = [];
    text.forEach((pageText, index) => {
      const body = pageText.replace(/[ \t]+\n/g, "\n").trim();
      if (body !== "") sections.push({ headingPath: [], page: index + 1, text: body });
    });
    return { sections };
  } finally {
    // Frees the document and its worker-side resources.
    await pdf.loadingTask.destroy();
  }
}

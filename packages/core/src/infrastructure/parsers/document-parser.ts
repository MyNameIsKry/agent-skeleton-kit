import path from "node:path";
import { IngestError } from "../../domain/errors.js";
import type { ParsedDocument } from "../../domain/knowledge.js";
import type { DocumentParser } from "../../domain/ports.js";
import { parseMarkdown } from "./markdown-parser.js";
import { parsePdf } from "./pdf-parser.js";

/** Chooses a parser by file extension. */
export class ExtensionDocumentParser implements DocumentParser {
  async parse(source: string, bytes: Uint8Array): Promise<ParsedDocument> {
    const extension = path.posix.extname(source).toLowerCase();
    switch (extension) {
      case ".md":
      case ".markdown":
        return this.#markdown(source, bytes);
      case ".pdf":
        try {
          return await parsePdf(bytes);
        } catch (error) {
          throw new IngestError(`${source} is not a readable PDF`, false, { cause: error });
        }
      default:
        throw new IngestError(`${source} has an unsupported file type "${extension}"`, false);
    }
  }

  #markdown(source: string, bytes: Uint8Array): ParsedDocument {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new IngestError(`${source} is not valid UTF-8 text`, false, { cause: error });
    }
    return parseMarkdown(text);
  }
}

import type { NewChunk } from "../../src/domain/chunk.js";
import { axis } from "./mongo.js";

/** A chunk for tests. The embedding is a unit vector along `axisIndex`. */
export const newChunk = (
  docId: string,
  version: number,
  idx: number,
  text: string,
  axisIndex = 0,
): NewChunk => ({
  docId,
  source: "doc.md",
  version,
  idx,
  text,
  embedding: axis(axisIndex),
  embeddingModel: "test-embedding",
  meta: { headingPath: ["Doc"] },
});

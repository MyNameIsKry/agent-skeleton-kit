// Test fakes for core and tenant tests: `@agent-skeleton/core/testing`.
// They follow the same tenant scoping rules as the real adapters.
export {
  FakeEmbeddingProvider,
  type FakeEmbeddingProviderOptions,
} from "./testing/fake-embedding-provider.js";
export { InMemoryChunkRepository, InMemoryDocumentRepository } from "./testing/in-memory-repositories.js";

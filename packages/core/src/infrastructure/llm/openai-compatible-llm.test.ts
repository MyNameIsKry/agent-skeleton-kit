import { describe, expect, it } from "vitest";
import { fakeFetch, json, recordingSleep } from "../../../test/support/fake-fetch.js";
import type { Message } from "../../domain/conversation.js";
import { ProviderError } from "../../domain/errors.js";
import type { LlmChatRequest } from "../../domain/ports.js";
import { OpenAiCompatibleLlm } from "./openai-compatible-llm.js";

const llm = (fetch: ReturnType<typeof fakeFetch>["fetch"]) =>
  new OpenAiCompatibleLlm({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    fetch,
    sleep: recordingSleep().sleep,
  });

const request = (overrides: Partial<LlmChatRequest> = {}): LlmChatRequest => ({
  messages: [{ role: "user", content: "Hi" }],
  tools: [],
  signal: new AbortController().signal,
  ...overrides,
});

const completion = (message: Record<string, unknown>, usage?: Record<string, number>) =>
  json({
    id: "c1",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
    usage,
  });

describe("OpenAiCompatibleLlm", () => {
  it("maps messages, history with tool calls, and tools to the OpenAI request format", async () => {
    const { fetch, requests } = fakeFetch(completion({ content: "Done." }));
    const messages: Message[] = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Open a ticket" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call_1", name: "create_it_ticket", arguments: { title: "VPN", priority: "high" } },
        ],
      },
      { role: "tool", toolCallId: "call_1", name: "create_it_ticket", content: '{"ticketId":"IT-1"}' },
    ];

    await llm(fetch).chat(
      request({
        messages,
        tools: [
          {
            name: "create_it_ticket",
            description: "Opens a ticket.",
            parameters: { type: "object", additionalProperties: false, properties: {} },
          },
        ],
      }),
    );

    expect(requests[0]?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(requests[0]?.body).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Open a ticket" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "create_it_ticket", arguments: '{"title":"VPN","priority":"high"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"ticketId":"IT-1"}' },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "create_it_ticket",
            description: "Opens a ticket.",
            parameters: { type: "object", additionalProperties: false, properties: {} },
          },
        },
      ],
      tool_choice: "auto",
    });
  });

  it("sends temperature only when it is configured", async () => {
    const { fetch, requests } = fakeFetch(completion({ content: "a" }), completion({ content: "b" }));
    await llm(fetch).chat(request());
    await new OpenAiCompatibleLlm({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "test-model",
      temperature: 0.2,
      fetch,
    }).chat(request());
    expect(requests[0]?.body).not.toHaveProperty("temperature");
    expect(requests[1]?.body).toMatchObject({ temperature: 0.2 });
  });

  it("sends empty content instead of null for an assistant message without tool calls", async () => {
    const { fetch, requests } = fakeFetch(completion({ content: "ok" }));
    await llm(fetch).chat(request({ messages: [{ role: "assistant", content: null }] }));
    const body = requests[0]?.body as { messages: unknown[] };
    expect(body.messages).toEqual([{ role: "assistant", content: "" }]);
  });

  it("keeps the answer when the usage object is not standard", async () => {
    const { fetch } = fakeFetch(
      json({
        choices: [{ message: { role: "assistant", content: "Hello" } }],
        usage: { prompt_tokens: 5, total_tokens: 9 },
      }),
    );
    await expect(llm(fetch).chat(request())).resolves.toEqual({ content: "Hello", toolCalls: [] });
  });

  it("omits tools and tool_choice when the tenant has no tools", async () => {
    const { fetch, requests } = fakeFetch(completion({ content: "Hello" }));
    await llm(fetch).chat(request());
    expect(requests[0]?.body).not.toHaveProperty("tools");
    expect(requests[0]?.body).not.toHaveProperty("tool_choice");
  });

  it("returns text content and token usage", async () => {
    const { fetch } = fakeFetch(
      completion({ content: "Hello" }, { prompt_tokens: 12, completion_tokens: 3 }),
    );
    await expect(llm(fetch).chat(request())).resolves.toEqual({
      content: "Hello",
      toolCalls: [],
      usage: { promptTokens: 12, completionTokens: 3 },
    });
  });

  it("parses tool calls and their JSON arguments", async () => {
    const { fetch } = fakeFetch(
      completion({
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "check_order_status", arguments: '{"order_id":"ORD-1001"}' },
          },
          { id: "call_2", type: "function", function: { name: "no_args", arguments: "" } },
        ],
      }),
    );
    const response = await llm(fetch).chat(request());
    expect(response.content).toBeNull();
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "check_order_status", arguments: { order_id: "ORD-1001" } },
      { id: "call_2", name: "no_args", arguments: {} },
    ]);
  });

  it("passes arguments that are not valid JSON through as the raw string", async () => {
    const { fetch } = fakeFetch(
      completion({
        tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{order_id: ORD" } }],
      }),
    );
    const response = await llm(fetch).chat(request());
    expect(response.toolCalls).toEqual([{ id: "c", name: "t", arguments: "{order_id: ORD" }]);
  });

  it("sends raw-string arguments back unchanged in later turns", async () => {
    const { fetch, requests } = fakeFetch(completion({ content: "ok" }));
    await llm(fetch).chat(
      request({
        messages: [
          { role: "assistant", content: null, toolCalls: [{ id: "c", name: "t", arguments: "{bad" }] },
        ],
      }),
    );
    const body = requests[0]?.body as { messages: { tool_calls: { function: { arguments: string } }[] }[] };
    expect(body.messages[0]?.tool_calls[0]?.function.arguments).toBe("{bad");
  });

  it.each([
    [
      "a tool call without an id",
      { tool_calls: [{ type: "function", function: { name: "t", arguments: "{}" } }] },
    ],
    [
      "a tool call without a function name",
      { tool_calls: [{ id: "c", type: "function", function: { arguments: "{}" } }] },
    ],
  ])("raises ProviderError for %s", async (_label, message) => {
    const { fetch } = fakeFetch(completion(message));
    const error = await llm(fetch)
      .chat(request())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(
      /^LLM returned a malformed response \(at choices\.0\.message\.tool_calls/,
    );
  });

  it("raises ProviderError when there are no choices", async () => {
    const { fetch } = fakeFetch(json({ choices: [] }));
    await expect(llm(fetch).chat(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it("retries a 429 and then returns the answer", async () => {
    const { fetch, requests } = fakeFetch(json({}, 429), completion({ content: "after retry" }));
    await expect(llm(fetch).chat(request())).resolves.toMatchObject({ content: "after retry" });
    expect(requests).toHaveLength(2);
  });
});

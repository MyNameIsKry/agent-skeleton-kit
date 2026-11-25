/**
 * LlmProvider for OpenAI-compatible `/chat/completions` APIs with function calling.
 * See design.md section 3a.
 */
import { z } from "zod";
import type { Message, ToolCall } from "../../domain/conversation.js";
import { ProviderError } from "../../domain/errors.js";
import type { LlmChatRequest, LlmProvider, LlmResponse, Logger } from "../../domain/ports.js";
import { DEFAULT_LLM_TIMEOUT_MS } from "../openai-compatible/defaults.js";
import {
  OpenAiCompatibleClient,
  type FetchFn,
  type RetryPolicy,
  type SleepFn,
} from "../openai-compatible/http-client.js";

export interface OpenAiCompatibleLlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /**
   * 0 to 2. Sent only when set: reasoning models (OpenAI o-series, gpt-5) reject any
   * `temperature`, so the provider default is used when this is undefined.
   */
  temperature?: number | undefined;
  retry?: RetryPolicy;
  fetch?: FetchFn;
  sleep?: SleepFn;
  logger?: Logger;
}

// --- Wire format -----------------------------------------------------------------------

type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

const wireToolCall = z.object({
  id: z.string().min(1),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string().min(1), arguments: z.string().optional() }),
});

const wireResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(wireToolCall).nullish(),
        }),
      }),
    )
    .min(1),
  // Usage is informational. A provider with a non-standard usage object must not cost the user
  // a valid answer, so anything unexpected here is dropped instead of failing the call.
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish().catch(undefined),
});

/** Arguments go back to the model exactly as it understood them. */
const serializeArguments = (args: unknown): string =>
  typeof args === "string" ? args : JSON.stringify(args ?? {});

function toWireMessage(message: Message): WireMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant": {
      const toolCalls = message.toolCalls ?? [];
      const hasToolCalls = toolCalls.length > 0;
      // OpenAI requires content unless tool_calls is present. A reply cut off by a content
      // filter can have neither, and replaying it as null would fail every later turn.
      const wire: WireMessage = {
        role: "assistant",
        content: hasToolCalls ? message.content : (message.content ?? ""),
      };
      if (hasToolCalls) {
        wire.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: serializeArguments(call.arguments) },
        }));
      }
      return wire;
    }
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

/**
 * Invalid JSON stays a raw string. The tool runtime rejects it against the `type: object`
 * schema and reports the error to the model, which can then retry with valid arguments.
 */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export class OpenAiCompatibleLlm implements LlmProvider {
  readonly #client: OpenAiCompatibleClient;
  readonly #model: string;
  readonly #temperature: number | undefined;

  constructor(options: OpenAiCompatibleLlmOptions) {
    this.#model = options.model;
    this.#temperature = options.temperature;
    this.#client = new OpenAiCompatibleClient({
      label: "LLM",
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  async chat(request: LlmChatRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: request.messages.map(toWireMessage),
    };
    if (this.#temperature !== undefined) body.temperature = this.#temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = "auto";
    }

    const raw = await this.#client.postJson("/chat/completions", body, request.signal);
    const parsed = wireResponse.safeParse(raw);
    if (!parsed.success) {
      const where = parsed.error.issues[0]?.path.join(".") ?? "response";
      throw new ProviderError(`LLM returned a malformed response (at ${where || "response"})`);
    }

    const [choice] = parsed.data.choices as [z.output<typeof wireResponse>["choices"][number]];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments),
    }));

    const response: LlmResponse = { content: choice.message.content ?? null, toolCalls };
    const usage = parsed.data.usage;
    if (usage !== null && usage !== undefined) {
      response.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
    }
    return response;
  }
}

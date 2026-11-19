/** A tool call requested by the model. Arguments are untrusted until validated. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: readonly ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolCallError {
  code: string;
  message: string;
}

/** What the API returns about one executed (or rejected) tool call. */
export interface ToolCallRecord {
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: ToolCallError;
  durationMs: number;
}

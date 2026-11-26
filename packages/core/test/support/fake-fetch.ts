import type { FetchFn } from "../../src/infrastructure/openai-compatible/http-client.js";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** One scripted reply: a Response, an error to throw, or a function of the request. */
export type ScriptedReply =
  Response | Error | ((request: RecordedRequest, init: RequestInit) => Promise<Response>);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A reply that waits until the request is aborted, then rejects like real fetch does. */
export const hang = (): ScriptedReply => (_request, init) =>
  new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (signal === null || signal === undefined) return;
    signal.addEventListener(
      "abort",
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

/** A fetch that replies from a script, in order, and records every request. */
export function fakeFetch(...script: ScriptedReply[]) {
  const requests: RecordedRequest[] = [];
  const fetch: FetchFn = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(request);
    const reply = script.shift();
    if (reply === undefined) throw new Error(`Unexpected request #${requests.length} to ${url}`);
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(request, init);
    return reply;
  };
  return { fetch, requests };
}

/** A sleep that records delays and returns at once. */
export function recordingSleep() {
  const delays: number[] = [];
  const sleep = (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

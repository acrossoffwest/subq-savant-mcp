import { describe, expect, it, vi, type Mock } from "vitest";
import { ApiError, SubqClient } from "../src/client.js";

type FetchMock = Mock<typeof fetch>;

const noSleep = async () => {};
const encoder = new TextEncoder();

const makeClient = (fetchImpl: FetchMock, sleep: (ms: number) => Promise<void> = noSleep) =>
  new SubqClient({ apiKey: "test-key", fetchImpl, sleep });

const streamResponse = (chunks: string[], status = 200): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
};

const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const contentEvent = (content: string) => ({ choices: [{ delta: { content } }] });
const reasoningEvent = (reasoning: string) => ({ choices: [{ delta: { reasoning } }] });
const finishEvent = (finish_reason: string) => ({ choices: [{ delta: {}, finish_reason }] });
const DONE = "data: [DONE]\n\n";

const jsonResponse = (status: number, payload: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });

const chatOpts = { user: "hi", maxTokens: 1000, effort: "high" as const };

describe("SubqClient.chat request shape", () => {
  it("posts a streaming chat completion with the expected headers and body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([DONE]));
    const client = makeClient(fetchImpl);

    await client.chat({ system: "be brief", ...chatOpts });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.subq.ai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key", "Content-Type": "application/json" });

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "subq-savant-1.4",
      max_tokens: 1000,
      reasoning_effort: "high",
      stream: true,
      stream_options: { include_usage: true },
      store: false,
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("omits the system message when none is provided", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([DONE]));
    const client = makeClient(fetchImpl);

    await client.chat(chatOpts);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("SubqClient.chat SSE parsing", () => {
  it("assembles content, reasoning, finish reason and usage across split chunks", async () => {
    const split = event(contentEvent("Hello, "));
    const cut = Math.floor(split.length / 2);
    const chunks = [
      ": keepalive\n\n",
      event(reasoningEvent("Let me think. ")),
      split.slice(0, cut),
      split.slice(cut),
      event(reasoningEvent("More.")),
      event(contentEvent("world")),
      event(finishEvent("stop")),
      event({
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 200 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }),
      DONE,
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(chunks));
    const onProgress = vi.fn();
    const client = makeClient(fetchImpl);

    const result = await client.chat(chatOpts, { onProgress });

    expect(result.content).toBe("Hello, world");
    expect(result.reasoningChars).toBe("Let me think. ".length + "More.".length);
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 200 },
      completion_tokens_details: { reasoning_tokens: 30 },
    });
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress).toHaveBeenLastCalledWith({
      contentChars: "Hello, world".length,
      reasoningChars: "Let me think. ".length + "More.".length,
    });
  });

  it("returns null content when only reasoning arrives before finish_reason length", async () => {
    const chunks = [
      event(reasoningEvent("thinking a lot")),
      event(reasoningEvent(" still thinking")),
      event(finishEvent("length")),
      DONE,
    ];
    const client = makeClient(vi.fn<typeof fetch>().mockResolvedValue(streamResponse(chunks)));

    const result = await client.chat(chatOpts);

    expect(result.content).toBeNull();
    expect(result.finishReason).toBe("length");
    expect(result.reasoningChars).toBe("thinking a lot still thinking".length);
  });

  it("rejects when the stream ends without [DONE]", async () => {
    const chunks = [event(contentEvent("partial"))];
    const client = makeClient(vi.fn<typeof fetch>().mockResolvedValue(streamResponse(chunks)));

    await expect(client.chat(chatOpts)).rejects.toThrow(/before \[DONE\]/);
  });

  it("rejects with ApiError for a mid-stream error event", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      streamResponse([event(contentEvent("abc")), event({ error: { message: "x", code: "y" } }), DONE]),
    );
    const client = makeClient(fetchImpl);

    await expect(client.chat(chatOpts)).rejects.toBeInstanceOf(ApiError);
    await expect(client.chat(chatOpts)).rejects.toMatchObject({ message: "x", code: "y" });
  });
});

describe("SubqClient HTTP errors", () => {
  it("maps 401 to ApiError with code, message hint and no retry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(401, { error: { code: "invalid_api_key", message: "bad" } }));
    const client = makeClient(fetchImpl);

    await expect(client.chat(chatOpts)).rejects.toMatchObject({ status: 401, code: "invalid_api_key" });
    await expect(client.chat(chatOpts)).rejects.toThrow(/SUBQ_API_KEY/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("mentions the model in the 403 message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(403, { error: { code: "forbidden", message: "no access" } }));
    const client = makeClient(fetchImpl);

    await expect(client.chat(chatOpts)).rejects.toThrow(/model/);
  });

  it("surfaces the error code for a 400 context_length_exceeded", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(400, { error: { code: "context_length_exceeded", message: "too many tokens" } }),
      );
    const client = makeClient(fetchImpl);

    await expect(client.chat(chatOpts)).rejects.toMatchObject({
      status: 400,
      code: "context_length_exceeded",
    });
  });
});

describe("SubqClient retries", () => {
  it("retries a 429 and succeeds on the second attempt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(429, { error: { code: "rate_limited", message: "slow down" } }))
      .mockResolvedValueOnce(streamResponse([event(contentEvent("ok")), event(finishEvent("stop")), DONE]));
    const client = makeClient(fetchImpl);

    const result = await client.chat(chatOpts);

    expect(result.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts (3) consecutive 502 responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 502 }));
    const client = makeClient(fetchImpl);

    await expect(client.chat(chatOpts)).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { error: { code: "invalid_api_key", message: "bad" } }));
    const sleep = vi.fn(async (_ms: number) => {});
    const client = makeClient(fetchImpl, sleep);

    await expect(client.chat(chatOpts)).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors Retry-After seconds when waiting before a retry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "slow" } }, { "retry-after": "2" }))
      .mockResolvedValueOnce(streamResponse([DONE]));
    const sleep = vi.fn(async (_ms: number) => {});
    const client = makeClient(fetchImpl, sleep);

    await client.chat(chatOpts);

    expect(sleep).toHaveBeenCalledWith(2000);
  });
});

describe("SubqClient.listModels", () => {
  it("returns the ids from the models list", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { data: [{ id: "a" }, { id: "subq-savant-1.4" }] }));
    const client = makeClient(fetchImpl);

    await expect(client.listModels()).resolves.toEqual(["a", "subq-savant-1.4"]);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.subq.ai/v1/models");
  });
});

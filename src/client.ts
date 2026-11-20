import { Agent, fetch as undiciFetch } from "undici";
import { BASE_URL, MODEL } from "./config.js";
import type { Usage } from "./tokens.js";

export type Effort = "low" | "high" | "max";

export interface ChatRequest {
  system?: string;
  user: string;
  maxTokens: number;
  effort: Effort;
}

export interface ChatResult {
  content: string | null;
  finishReason: string | null;
  reasoningChars: number;
  usage: Usage;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export class IncompleteStreamError extends Error {
  constructor(
    message: string,
    readonly partial: string,
  ) {
    super(message);
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([429, 502, 503, 504, 529]);
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });

const HINTS: Record<number, string> = {
  401: "invalid or missing SUBQ_API_KEY",
  402: "the SubQ organization is out of credits",
  403: "the key cannot call this model (Savant is early access, enabled per organization)",
};

export class SubqClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.model = opts.model ?? MODEL;
    this.fetchImpl =
      opts.fetchImpl ??
      (((url: string, init: RequestInit) =>
        undiciFetch(url, { ...init, dispatcher } as never)) as unknown as typeof fetch);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.request("/models", { method: "GET", signal });
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }

  async chat(
    req: ChatRequest,
    opts: { signal?: AbortSignal; onProgress?: (p: { contentChars: number; reasoningChars: number }) => void } = {},
  ): Promise<ChatResult> {
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.user },
    ];
    const body = JSON.stringify({
      model: this.model,
      messages,
      max_tokens: req.maxTokens,
      reasoning_effort: req.effort,
      stream: true,
      stream_options: { include_usage: true },
      store: false,
    });
    const res = await this.request("/chat/completions", { method: "POST", body, signal: opts.signal });
    return this.readStream(res, opts.onProgress);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}` };
    if (init.body) headers["Content-Type"] = "application/json";
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
      } catch (err) {
        if (init.signal?.aborted || attempt >= this.maxAttempts) throw err;
        await this.sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) return res;
      if (RETRYABLE.has(res.status) && attempt < this.maxAttempts) {
        await res.body?.cancel().catch(() => {});
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay =
          retryAfter > 0
            ? Math.min(retryAfter, 60) * 1000
            : 2000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        await this.sleep(delay);
        continue;
      }
      throw await toApiError(res);
    }
  }

  private async readStream(
    res: Response,
    onProgress?: (p: { contentChars: number; reasoningChars: number }) => void,
  ): Promise<ChatResult> {
    if (!res.body) throw new Error("SubQ API returned an empty response body");
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buf = "";
    let content = "";
    let reasoningChars = 0;
    let finishReason: string | null = null;
    let usage: Usage = {};
    let done = false;

    const handleLine = (line: string): void => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        return;
      }
      const chunk = JSON.parse(data) as {
        error?: { message?: string; code?: string };
        usage?: Usage;
        choices?: { delta?: { content?: string | null; reasoning?: string | null }; finish_reason?: string | null }[];
      };
      if (chunk.error) throw new ApiError(chunk.error.message ?? "stream error", 200, chunk.error.code);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.delta?.content) content += choice.delta.content;
      if (choice.delta?.reasoning) reasoningChars += choice.delta.reasoning.length;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      onProgress?.({ contentChars: content.length, reasoningChars });
    };

    try {
      for (;;) {
        const { value, done: eof } = await reader.read().catch((err) => {
          throw content
            ? new IncompleteStreamError(`SubQ stream failed: ${err instanceof Error ? err.message : err}`, content)
            : err;
        });
        if (value) buf += decoder.decode(value, { stream: !eof });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, nl).replace(/\r$/, ""));
          buf = buf.slice(nl + 1);
        }
        if (eof) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    if (buf.trim()) handleLine(buf.trim());
    if (!done) throw new IncompleteStreamError("SubQ stream ended before [DONE]; the response is incomplete", content);
    return { content: content || null, finishReason, reasoningChars, usage };
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let code: string | undefined;
  let message = res.statusText;
  try {
    const parsed = JSON.parse(await res.text()) as { error?: { message?: string; code?: string }; detail?: unknown };
    code = parsed.error?.code;
    message = parsed.error?.message ?? (parsed.detail ? JSON.stringify(parsed.detail) : message);
  } catch {}
  const hint = HINTS[res.status] ? ` (${HINTS[res.status]})` : "";
  return new ApiError(`SubQ API ${res.status}${code ? ` ${code}` : ""}: ${message}${hint}`, res.status, code);
}

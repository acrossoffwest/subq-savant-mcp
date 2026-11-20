import { CONTEXT_WINDOW, PRICE_PER_M } from "./config.js";

const BYTES_PER_TOKEN = 3.2;
const WINDOW_SAFETY = 0.95;

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  return estimateTokensFromBytes(Buffer.byteLength(text, "utf8"));
}

export function checkWindow(inputTokens: number, maxTokens: number, window = CONTEXT_WINDOW): void {
  if (inputTokens + maxTokens > window * WINDOW_SAFETY) {
    throw new Error(
      `Context too large: ~${inputTokens.toLocaleString("en-US")} input tokens + max_tokens ${maxTokens.toLocaleString("en-US")} exceeds 95% of the ${window.toLocaleString("en-US")}-token window (the estimate is approximate). ` +
        `Narrow paths, add exclude globs, set exclude_tests, or lower max_tokens. Use savant_pack_preview to see what is included.`,
    );
  }
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export function estimateCost(usage: Usage): number {
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return ((prompt - cached) * PRICE_PER_M.input + cached * PRICE_PER_M.cachedInput + output * PRICE_PER_M.output) / 1e6;
}

export function estimateInputCost(inputTokens: number): number {
  return (inputTokens * PRICE_PER_M.input) / 1e6;
}

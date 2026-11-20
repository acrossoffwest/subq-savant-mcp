import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IncompleteStreamError, type Effort, type SubqClient } from "./client.js";
import { CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./config.js";
import { pack, topDirs, type PackOptions, type PackResult } from "./pack.js";
import { checkWindow, estimateCost, estimateInputCost, estimateTokens } from "./tokens.js";

export const INLINE_LIMIT_CHARS = 60_000;

const DEFAULT_SYSTEM =
  'You are a senior analyst working over a large body of source material. Files are given as <file path="..."> blocks; ' +
  "lines are prefixed with `N| ` line numbers. Cite evidence as path:line. Be precise, say when the material does not contain " +
  "the answer, and never invent files or symbols.";

export interface SourceInput extends Omit<PackOptions, "paths"> {
  paths?: string[];
}

export interface AskInput extends SourceInput {
  prompt: string;
  context?: string;
  system?: string;
  effort?: Effort;
  maxTokens?: number;
  outputFile?: string;
  overwrite?: boolean;
}

export interface AskDeps {
  client: SubqClient;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

const n = (v: number): string => v.toLocaleString("en-US");

function packSources(input: SourceInput): PackResult | undefined {
  return input.paths?.length ? pack({ ...input, paths: input.paths }) : undefined;
}

function skippedLine(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped).map(([k, v]) => `${k}=${v}`);
  return parts.length ? `skipped: ${parts.join(", ")}` : "skipped: none";
}

export function previewPack(input: SourceInput & { maxList?: number }): string {
  if (!input.paths?.length) throw new Error("paths is required");
  const res = pack({ ...input, paths: input.paths });
  const max = input.maxList ?? 200;
  const lines = [
    `files: ${n(res.files.length)} | est input tokens: ~${n(res.tokens)} (${((res.tokens / CONTEXT_WINDOW) * 100).toFixed(1)}% of window) | est input cost: ~$${estimateInputCost(res.tokens).toFixed(2)}`,
    skippedLine(res.skipped),
    "",
    "top directories by tokens:",
    ...topDirs(res.files).map((d) => `  ${d.dir}  ${n(d.files)} files  ~${n(d.tokens)} tokens`),
    "",
    "files (largest first):",
    ...[...res.files]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, max)
      .map((f) => `  ~${n(f.tokens)}  ${f.path}`),
  ];
  if (res.files.length > max) lines.push(`  ... ${n(res.files.length - max)} more`);
  return lines.join("\n");
}

function saveAnswer(answer: string, outputFile: string | undefined, root: string, overwrite: boolean): string {
  if (outputFile) {
    const target = resolve(root, outputFile);
    writeFileSync(target, answer, { flag: overwrite ? "w" : "wx", mode: 0o600 });
    return target;
  }
  const target = join(mkdtempSync(join(tmpdir(), "subq-savant-")), "answer.md");
  writeFileSync(target, answer, { mode: 0o600 });
  return target;
}

export async function ask(input: AskInput, deps: AskDeps): Promise<{ text: string; isError: boolean }> {
  const root = resolve(input.root ?? process.cwd());
  const packed = packSources({ ...input, root });
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const system = input.system ?? DEFAULT_SYSTEM;
  const user = [
    packed ? `<context>\n${packed.text}</context>` : "",
    input.context ? `<extra_context>\n${input.context}\n</extra_context>` : "",
    `Task:\n${input.prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const estInput = estimateTokens(system) + estimateTokens(user);
  checkWindow(estInput, maxTokens);
  deps.onProgress?.(`sending ~${n(estInput)} tokens (${packed?.files.length ?? 0} files)`);

  const result = await deps.client
    .chat(
      { system, user, maxTokens, effort: input.effort ?? "high" },
      {
        signal: deps.signal,
        onProgress: (p) =>
          deps.onProgress?.(`receiving: reasoning ${n(p.reasoningChars)} chars, answer ${n(p.contentChars)} chars`),
      },
    )
    .catch((err) => {
      if (err instanceof IncompleteStreamError && err.partial) {
        const path = saveAnswer(err.partial, undefined, root, false);
        throw new Error(`${err.message}. Partial answer (${n(err.partial.length)} chars) saved to: ${path}`);
      }
      throw err;
    });

  const u = result.usage;
  const footer = [
    `files: ${packed ? n(packed.files.length) : 0} | root: ${root} | ${packed ? skippedLine(packed.skipped) : "no paths"}`,
    `est input: ~${n(estInput)} | api prompt_tokens: ${n(u.prompt_tokens ?? 0)} (cached ${n(u.prompt_tokens_details?.cached_tokens ?? 0)}) | completion: ${n(u.completion_tokens ?? 0)} (reasoning ${n(u.completion_tokens_details?.reasoning_tokens ?? 0)}) | finish: ${result.finishReason}`,
    `cost: ~$${estimateCost(u).toFixed(4)}`,
  ].join("\n");

  if (result.content === null) {
    const why =
      result.finishReason === "length"
        ? `max_tokens (${n(maxTokens)}) was consumed by reasoning before the answer started. Retry with a larger max_tokens or reasoning_effort "low".`
        : "the model returned no answer text.";
    return { text: `No answer: ${why}\n\n---\n${footer}`, isError: true };
  }

  const truncated = result.finishReason === "length" ? "\n\n[answer truncated: max_tokens reached]" : "";
  const full = result.content + truncated;
  const tooBig = full.length > INLINE_LIMIT_CHARS;
  if (!input.outputFile && !tooBig) return { text: `${full}\n\n---\n${footer}`, isError: false };

  const path = saveAnswer(full, input.outputFile, root, input.overwrite ?? false);
  const previewLen = tooBig ? 4000 : 2000;
  const preview = full.length > previewLen ? `${full.slice(0, previewLen)}\n\n[... preview only ...]` : full;
  return {
    text: `${preview}\n\nFull answer (${n(full.length)} chars) saved to: ${path}\n\n---\n${footer}`,
    isError: false,
  };
}

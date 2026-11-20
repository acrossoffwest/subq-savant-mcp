import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, previewPack } from "../src/ask.js";
import type { ChatRequest, ChatResult, SubqClient } from "../src/client.js";

const usage = {
  prompt_tokens: 1234,
  completion_tokens: 56,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 10 },
};

const answer = (overrides: Partial<ChatResult> = {}): ChatResult => ({
  content: "The answer is 42.",
  finishReason: "stop",
  reasoningChars: 120,
  usage,
  ...overrides,
});

const fakeClient = (result: ChatResult = answer()) => {
  const chat = vi.fn<(req: ChatRequest, opts?: unknown) => Promise<ChatResult>>(async () => result);
  return { chat, client: { chat } as unknown as SubqClient };
};

const createdDirs: string[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subq-ask-fixture-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "b.ts"), "export function b() {\n  return 2;\n}\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ask prompt construction", () => {
  it("packs sources with line numbers and puts the task after a Task line", async () => {
    const { chat, client } = fakeClient();

    await ask({ root: dir, paths: ["."], prompt: "What does b return?" }, { client });

    const req = chat.mock.calls[0][0];
    expect(req.user).toContain('<file path="a.ts">');
    expect(req.user).toContain('<file path="src/b.ts">');
    expect(req.user).toContain("1| export const a = 1;");
    expect(req.user).toMatch(/Task:\nWhat does b return\?$/);
    expect(req.maxTokens).toBe(64_000);
    expect(req.effort).toBe("high");
  });

  it("rejects when the input plus max_tokens exceeds the window and does not call the API", async () => {
    const { chat, client } = fakeClient();

    await expect(
      ask({ root: dir, paths: ["."], prompt: "q", maxTokens: 4_194_304 }, { client }),
    ).rejects.toThrow(/Context too large/);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("ask results", () => {
  it("reports an error with a max_tokens hint when the answer is null and finish is length", async () => {
    const { client } = fakeClient(answer({ content: null, finishReason: "length" }));

    const result = await ask({ root: dir, paths: ["."], prompt: "q" }, { client });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("max_tokens");
  });

  it("returns the answer with a cost and token footer", async () => {
    const { client } = fakeClient();

    const result = await ask({ root: dir, paths: ["."], prompt: "q" }, { client });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("The answer is 42.");
    expect(result.text).toContain("cost:");
    expect(result.text).toContain("api prompt_tokens");
  });

  it("saves a long answer to a temp file and inlines only a preview", async () => {
    const long = "0123456789".repeat(7_000);
    const { client } = fakeClient(answer({ content: long }));

    const result = await ask({ root: dir, paths: ["."], prompt: "q" }, { client });

    expect(result.text).toContain("saved to:");
    expect(result.text).toContain("[... preview only ...]");
    expect(result.text.length).toBeLessThan(6_000);
    const saved = /saved to: (\S+)/.exec(result.text)?.[1];
    expect(saved).toBeDefined();
    createdDirs.push(dirname(saved as string));
    expect(readFileSync(saved as string, "utf8")).toBe(long);
  });

  it("writes outputFile with mode 0600, refuses to overwrite by default, and overwrites on request", async () => {
    const { chat, client } = fakeClient();
    const input = { root: dir, paths: ["."], prompt: "q", outputFile: "answer.md" };
    const target = join(dir, "answer.md");

    const first = await ask(input, { client });
    expect(first.text).toContain("saved to:");
    expect(readFileSync(target, "utf8")).toBe("The answer is 42.");
    expect(statSync(target).mode & 0o777).toBe(0o600);

    await expect(ask(input, { client })).rejects.toThrow(/already exists/);
    expect(chat).toHaveBeenCalledTimes(1);

    chat.mockResolvedValueOnce(answer({ content: "second answer" }));
    await ask({ ...input, overwrite: true }, { client });
    expect(readFileSync(target, "utf8")).toBe("second answer");
  });
});

describe("previewPack", () => {
  it("lists files and the estimated input tokens", () => {
    const text = previewPack({ root: dir, paths: ["."] });

    expect(text).toContain("files: 2");
    expect(text).toContain("est input tokens");
    expect(text).toContain("a.ts");
    expect(text).toContain("src/b.ts");
  });

  it("throws when no paths are given", () => {
    expect(() => previewPack({ root: dir })).toThrow("paths is required");
  });
});

describe("ask output_file confinement", () => {
  it("rejects a missing directory or a target outside root before calling the API", async () => {
    const chat = vi.fn();
    const client = { chat } as unknown as SubqClient;
    const root = mkdtempSync(join(tmpdir(), "savant-ask-out-"));
    try {
      await expect(ask({ prompt: "q", root, outputFile: "nope/a.md" }, { client })).rejects.toThrow(/does not exist/);
      await expect(ask({ prompt: "q", root, outputFile: join(tmpdir(), "escape.md") }, { client })).rejects.toThrow(/outside/);
      expect(chat).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

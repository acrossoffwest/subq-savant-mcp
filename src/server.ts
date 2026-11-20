#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ask, previewPack } from "./ask.js";
import { SubqClient } from "./client.js";
import { CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, MODEL, loadApiKey } from "./config.js";
import { sourceShape } from "./shared.js";

const HEARTBEAT_MS = 15_000;

type Extra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>;
};

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
const fail = (e: unknown) => text(e instanceof Error ? e.message : String(e), true);

function client(): SubqClient {
  return new SubqClient({ apiKey: loadApiKey() });
}

const server = new McpServer({ name: "subq-savant", version: "0.1.0" });

server.registerTool(
  "savant_ask",
  {
    title: "Ask SubQ Savant over local files",
    description:
      `Send a prompt plus the contents of local files/directories (assembled by this server, up to ~${CONTEXT_WINDOW.toLocaleString("en-US")} tokens) to SubQ Savant, a long-context reasoning model, and return only its answer. ` +
      "Use for whole-codebase analysis: API-vs-routes diffs, dead code, cross-cutting bug sweeps, architecture maps. " +
      "Files are labeled with their paths and line numbers; answers cite path:line. Runs may take minutes. Use savant_pack_preview first to check size and cost. " +
      "Your code is sent to the SubQ API (storage disabled via store:false).",
    inputSchema: {
      prompt: z.string().min(1).describe("The question or task."),
      ...sourceShape,
      paths: sourceShape.paths
        .optional()
        .describe("Files or directories to include. Omit to ask without file context."),
      context: z.string().optional().describe("Extra inline text (small snippets, notes) appended to the context."),
      system: z.string().optional().describe("Override the default analyst system prompt."),
      reasoning_effort: z
        .enum(["low", "high", "max"])
        .optional()
        .describe("Default high. max = hardest questions; low = fast/cheap."),
      max_tokens: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          `Cap for reasoning + answer together. Default ${DEFAULT_MAX_TOKENS}. Input + max_tokens must fit the window.`,
        ),
      output_file: z
        .string()
        .optional()
        .describe(
          "Save the full answer to this file (fails if it exists unless overwrite). Answers over 60k chars are saved to a temp file automatically.",
        ),
      overwrite: z.boolean().optional().describe("Allow output_file to overwrite an existing file."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (a, extra) => {
    const e = extra as unknown as Extra;
    const token = e._meta?.progressToken;
    let counter = 0;
    let last = "starting";
    const beat = (): void => {
      if (token === undefined) return;
      e.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++counter, message: last },
      }).catch(() => {});
    };
    const timer = setInterval(beat, HEARTBEAT_MS);
    try {
      const r = await ask(
        {
          prompt: a.prompt,
          paths: a.paths,
          root: a.root,
          include: a.include,
          exclude: a.exclude,
          excludeTests: a.exclude_tests,
          lineNumbers: a.line_numbers,
          context: a.context,
          system: a.system,
          effort: a.reasoning_effort,
          maxTokens: a.max_tokens,
          outputFile: a.output_file,
          overwrite: a.overwrite,
        },
        { client: client(), signal: e.signal, onProgress: (m) => (last = m) },
      );
      return text(r.text, r.isError);
    } catch (err) {
      return fail(err);
    } finally {
      clearInterval(timer);
    }
  },
);

server.registerTool(
  "savant_pack_preview",
  {
    title: "Preview what savant_ask would send",
    description:
      "Dry run: list the files that would be packed, skipped counts by reason, estimated tokens and input cost. Makes no API call.",
    inputSchema: sourceShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (a) => {
    try {
      return text(
        previewPack({
          paths: a.paths,
          root: a.root,
          include: a.include,
          exclude: a.exclude,
          excludeTests: a.exclude_tests,
          lineNumbers: a.line_numbers,
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "savant_status",
  {
    title: "SubQ Savant status",
    description: "Check that the API key works and that the key can call the Savant model.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (_a, extra) => {
    try {
      const models = await client().listModels((extra as unknown as Extra).signal);
      const ok = models.includes(MODEL);
      return text(
        `${ok ? "OK" : "MODEL NOT AVAILABLE"}: ${MODEL} ${ok ? "is" : "is not"} listed for this key.\nmodels: ${models.join(", ")}`,
        !ok,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ask, previewPack } from "./ask.js";
import { SubqClient, type Effort } from "./client.js";
import { MODEL, loadApiKey } from "./config.js";

const USAGE = `Usage:
  subq-savant ask "<prompt>" [paths...] [options]
  subq-savant preview [paths...] [options]
  subq-savant status

Options:
  --root <dir>           base for relative paths (default: cwd)
  --include <glob>       repeatable allow-list
  --exclude <glob>       repeatable deny-list
  --exclude-tests        skip test files and directories
  --no-line-numbers      do not prefix lines with numbers
  --effort <low|high|max>
  --max-tokens <n>       cap for reasoning + answer
  --system <text>
  --context-file <file>  extra inline context from a file
  --prompt-file <file>   read the prompt from a file instead of the first argument
  --output <file>        save the full answer to a file
  --overwrite            allow --output to replace an existing file
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    "exclude-tests": { type: "boolean" },
    "no-line-numbers": { type: "boolean" },
    effort: { type: "string" },
    "max-tokens": { type: "string" },
    system: { type: "string" },
    "context-file": { type: "string" },
    "prompt-file": { type: "string" },
    output: { type: "string" },
    overwrite: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...rest] = positionals;
const source = {
  root: values.root,
  include: values.include,
  exclude: values.exclude,
  excludeTests: values["exclude-tests"],
  lineNumbers: values["no-line-numbers"] ? false : undefined,
};

async function main(): Promise<void> {
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "status") {
    const models = await new SubqClient({ apiKey: loadApiKey() }).listModels();
    const ok = models.includes(MODEL);
    process.stdout.write(`${ok ? "OK" : "MODEL NOT AVAILABLE"}: ${MODEL}\nmodels: ${models.join(", ")}\n`);
    process.exitCode = ok ? 0 : 1;
  } else if (cmd === "preview") {
    process.stdout.write(`${previewPack({ ...source, paths: rest })}\n`);
  } else if (cmd === "ask") {
    const prompt = values["prompt-file"] ? readFileSync(values["prompt-file"], "utf8") : rest.shift();
    if (!prompt) throw new Error("prompt is required");
    const maxTokens = values["max-tokens"] ? Number(values["max-tokens"]) : undefined;
    if (maxTokens !== undefined && !(Number.isInteger(maxTokens) && maxTokens > 0))
      throw new Error("--max-tokens must be a positive integer");
    const r = await ask(
      {
        ...source,
        prompt,
        paths: rest,
        context: values["context-file"] ? readFileSync(values["context-file"], "utf8") : undefined,
        system: values.system,
        effort: values.effort as Effort | undefined,
        maxTokens,
        outputFile: values.output,
        overwrite: values.overwrite,
      },
      {
        client: new SubqClient({ apiKey: loadApiKey() }),
        onProgress: process.stderr.isTTY ? (m) => process.stderr.write(`\r\x1b[K${m}`) : undefined,
      },
    );
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    process.stdout.write(`${r.text}\n`);
    process.exitCode = r.isError ? 1 : 0;
  } else {
    throw new Error(`Unknown command: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

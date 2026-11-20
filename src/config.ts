import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODEL = "subq-savant-1.4";
export const BASE_URL = "https://api.subq.ai/v1";
export const CONTEXT_WINDOW = 4_194_304;
export const DEFAULT_MAX_TOKENS = 64_000;
export const PRICE_PER_M = { input: 0.1, cachedInput: 0.01, output: 0.5 };

export const CONFIG_FILE = join(homedir(), ".config", "subq-savant-mcp", ".env");

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function loadApiKey(env: NodeJS.ProcessEnv = process.env, configFile = CONFIG_FILE): string {
  const fromEnv = env.SUBQ_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = parseEnvFile(readFileSync(configFile, "utf8")).SUBQ_API_KEY?.trim();
    if (fromFile) return fromFile;
  } catch {}
  throw new Error(
    `SUBQ_API_KEY is not set. Export it in the environment of the MCP client, or put SUBQ_API_KEY=... into ${configFile} (chmod 600).`,
  );
}

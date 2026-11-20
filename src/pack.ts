import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";
import { estimateTokensFromBytes } from "./tokens.js";

export interface PackOptions {
  paths: string[];
  root?: string;
  include?: string[];
  exclude?: string[];
  excludeTests?: boolean;
  lineNumbers?: boolean;
  maxFileBytes?: number;
  maxBytes?: number;
}

export interface PackedFile {
  path: string;
  chars: number;
  tokens: number;
}

export interface PackResult {
  text: string;
  files: PackedFile[];
  skipped: Record<string, number>;
  chars: number;
  tokens: number;
}

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".gradle",
  ".mvn",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "composer.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
  "Pipfile.lock",
]);

const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".svg",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".jar",
  ".war",
  ".class",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".o",
  ".a",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".wav",
  ".ogg",
  ".sqlite",
  ".db",
  ".pyc",
  ".map",
  ".psd",
  ".wasm",
  ".dmg",
  ".iso",
]);

const SECRET_NAME =
  /^(\.env(rc|\..+)?|.+\.env|\.pypirc|\.dockercfg|kubeconfig|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\..+)?|credentials(\.json)?|service-account.*\.json|.+\.(pem|key|p12|pfx|jks|keystore|tfstate|tfstate\.backup))$/i;
const SECRET_CONTENT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9_-]{32,}|\bxox[bpase]-[A-Za-z0-9-]{20,}|\bxapp-[A-Za-z0-9-]{20,}|\b[sr]k_live_[A-Za-z0-9]{20,}|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__mocks__", "testing"]);
const TEST_FILE =
  /(\.(test|spec)\.[^.]+$|_test\.(go|py|rb|rs)$|^test_.+\.py$|(Test|Tests|IT)\.(java|kt|cs)$|^conftest\.py$)/;

type Skip = (reason: string) => void;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function loadIgnore(dir: string): Ignore | undefined {
  try {
    return ignore().add(readFileSync(join(dir, ".gitignore"), "utf8"));
  } catch {
    return undefined;
  }
}

interface IgnoreLayer {
  base: string;
  ig: Ignore;
}

function isIgnored(layers: IgnoreLayer[], abs: string, isDir: boolean): boolean {
  for (const { base, ig } of layers) {
    const rel = toPosix(relative(base, abs));
    if (rel && !rel.startsWith("..") && ig.ignores(isDir ? `${rel}/` : rel)) return true;
  }
  return false;
}

function ancestorLayers(start: string): IgnoreLayer[] {
  const chain: string[] = [];
  let dir = start;
  for (;;) {
    chain.unshift(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  if (!existsSync(join(chain[0], ".git"))) return [];
  const layers: IgnoreLayer[] = [];
  for (const d of chain) {
    const ig = loadIgnore(d);
    if (ig) layers.push({ base: d, ig });
  }
  return layers;
}

function inside(base: string, abs: string): boolean {
  const rel = relative(base, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function realRoot(root?: string): string {
  const abs = resolve(root ?? process.cwd());
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function assertAllowed(abs: string, root: string): void {
  const extra = (process.env.SUBQ_ALLOWED_ROOTS ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((r) => resolve(r));
  const bases = extra.length ? extra : [root];
  if (!bases.some((b) => inside(b, abs))) {
    throw new Error(
      `${abs} is outside ${extra.length ? "SUBQ_ALLOWED_ROOTS" : "root"} (${bases.join(", ")}). Pass \`root\` pointing at the project that contains it${extra.length ? " (it must be inside SUBQ_ALLOWED_ROOTS)" : ""}.`,
    );
  }
}

export function pack(opts: PackOptions): PackResult {
  const root = realRoot(opts.root);
  if (root === resolve("/") || root === homedir())
    throw new Error(`Refusing to use ${root} as root: pass a project directory`);
  const maxTotal = opts.maxBytes ?? 24_000_000;
  const maxBytes = opts.maxFileBytes ?? 1_000_000;
  const skipped: Record<string, number> = {};
  const skip: Skip = (r) => {
    skipped[r] = (skipped[r] ?? 0) + 1;
  };
  const matcher = (globs?: string[]): ((p: string) => boolean) | undefined => {
    if (!globs?.length) return undefined;
    const ms = globs.map((g) => picomatch(g, { dot: true, basename: !g.includes("/") }));
    return (p) => ms.some((m) => m(p));
  };
  const includeM = matcher(opts.include);
  const excludeM = matcher(opts.exclude);
  const found = new Map<string, string>();

  const label = (abs: string): string => {
    const rel = relative(root, abs);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? toPosix(rel) : toPosix(abs);
  };

  const fileRejected = (abs: string, name: string, explicit: boolean): string | undefined => {
    if (SECRET_NAME.test(name) && !ENV_TEMPLATE.test(name)) return "secret";
    if (!explicit) {
      if (LOCKFILES.has(name)) return "lockfile";
      const lbl = label(abs);
      if (excludeM?.(lbl)) return "excluded";
      if (includeM && !includeM(lbl)) return "not_included";
      if (opts.excludeTests && (TEST_FILE.test(name) || lbl.split("/").some((s) => TEST_DIRS.has(s)))) return "test";
    }
    if (BINARY_EXT.has(extname(name).toLowerCase()) || /\.min\.(js|css)$/.test(name)) return "binary";
    return undefined;
  };

  const walk = (dir: string, layers: IgnoreLayer[]): void => {
    const own = loadIgnore(dir);
    const active = own ? [...layers, { base: dir, ig: own }] : layers;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skip("unreadable");
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) {
        skip("symlink");
      } else if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) skip("default_dir");
        else if (isIgnored(active, abs, true)) skip("gitignore");
        else if (excludeM?.(label(abs))) skip("excluded");
        else if (opts.excludeTests && TEST_DIRS.has(e.name)) skip("test");
        else walk(abs, active);
      } else if (e.isFile()) {
        if (isIgnored(active, abs, false)) skip("gitignore");
        else {
          const why = fileRejected(abs, e.name, false);
          if (why) skip(why);
          else found.set(abs, label(abs));
        }
      }
    }
  };

  for (const p of opts.paths) {
    let abs = resolve(root, p);
    try {
      abs = realpathSync(abs);
    } catch {
      throw new Error(`Path not found: ${p}`);
    }
    if (abs === resolve("/") || abs === homedir()) throw new Error(`Refusing to pack ${abs}: pass a project directory`);
    assertAllowed(abs, root);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`Path not found: ${p}`);
    }
    if (st.isDirectory()) walk(abs, ancestorLayers(abs));
    else if (st.isFile()) {
      const why = fileRejected(abs, basename(abs), true);
      if (why) skip(why);
      else found.set(abs, label(abs));
    }
  }

  const files: PackedFile[] = [];
  const parts: string[] = [];
  let chars = 0;
  let bytes = 0;
  const sorted = [...found.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [abs, lbl] of sorted) {
    let content: string;
    try {
      if (statSync(abs).size > maxBytes) {
        skip("too_large");
        continue;
      }
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) {
        skip("binary");
        continue;
      }
      content = new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
    } catch {
      skip("unreadable");
      continue;
    }
    if (SECRET_CONTENT.test(content)) {
      skip("secret");
      continue;
    }
    if (content.trim() === "") {
      skip("empty");
      continue;
    }
    const body =
      opts.lineNumbers === false
        ? content
        : content
            .split("\n")
            .map((l, i) => `${i + 1}| ${l}`)
            .join("\n");
    const attr = lbl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const block = `<file path="${attr}">\n${body}${body.endsWith("\n") ? "" : "\n"}</file>\n`;
    const blockBytes = Buffer.byteLength(block, "utf8");
    bytes += blockBytes;
    if (bytes > maxTotal) {
      throw new Error(
        `Packed content exceeds ${maxTotal.toLocaleString("en-US")} bytes (~${estimateTokensFromBytes(bytes).toLocaleString("en-US")}+ tokens) after ${files.length} files. Narrow paths or add exclude globs.`,
      );
    }
    parts.push(block);
    chars += block.length;
    files.push({ path: lbl, chars: block.length, tokens: estimateTokensFromBytes(blockBytes) });
  }
  return { text: parts.join(""), files, skipped, chars, tokens: estimateTokensFromBytes(bytes) };
}

export function topDirs(files: PackedFile[], limit = 10): { dir: string; files: number; tokens: number }[] {
  const acc = new Map<string, { files: number; tokens: number }>();
  for (const f of files) {
    const segs = f.path.split("/");
    const key = segs.length > 2 ? `${segs[0]}/${segs[1]}` : segs.length > 1 ? segs[0] : ".";
    const cur = acc.get(key) ?? { files: 0, tokens: 0 };
    cur.files++;
    cur.tokens += f.tokens;
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .map(([dir, v]) => ({ dir, ...v }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

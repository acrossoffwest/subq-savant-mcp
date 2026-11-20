import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pack, topDirs, type PackResult } from "../src/pack.js";
import { checkWindow, estimateCost, estimateTokens, estimateTokensFromBytes } from "../src/tokens.js";

let dir: string;

const put = (rel: string, content: string | Buffer = "x\n"): void => {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

const labels = (r: PackResult): string[] => r.files.map((f) => f.path);

const packDir = (extra: Partial<Parameters<typeof pack>[0]> = {}): PackResult =>
  pack({ paths: [dir], root: dir, ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "savant-pack-"));
  mkdirSync(join(dir, ".git"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pack: gitignore", () => {
  it("honors root and nested .gitignore layers", () => {
    put(".gitignore", "*.log\n");
    put("sub/.gitignore", "local.txt\n");
    put("app.log");
    put("keep.ts", "export const k = 1;\n");
    put("local.txt");
    put("sub/local.txt");
    put("sub/keep.ts", "export const s = 1;\n");

    const r = packDir();

    expect(labels(r)).toContain("keep.ts");
    expect(labels(r)).toContain("local.txt");
    expect(labels(r)).toContain("sub/keep.ts");
    expect(labels(r)).not.toContain("app.log");
    expect(labels(r)).not.toContain("sub/local.txt");
    expect(r.skipped.gitignore).toBe(2);
  });
});

describe("pack: default directory skips", () => {
  it("skips node_modules, dist and .git directories", () => {
    put("node_modules/pkg/index.js", "module.exports = 1;\n");
    put("packages/app/node_modules/x.js", "x\n");
    put("dist/out.js", "out\n");
    put("src/a.ts", "export const a = 1;\n");

    const r = packDir();

    expect(labels(r)).toEqual(["src/a.ts"]);
    expect(r.skipped.default_dir).toBe(4);
  });
});

describe("pack: binary detection", () => {
  it("skips binary files by extension", () => {
    put("logo.png", "not really a png\n");
    put("font.woff2", "font\n");
    put("ok.txt", "ok\n");

    const r = packDir();

    expect(labels(r)).toEqual(["ok.txt"]);
    expect(r.skipped.binary).toBe(2);
  });

  it("skips files with a NUL byte even when the extension is unknown", () => {
    put("blob.dat", Buffer.from([0x68, 0x00, 0x69]));
    put("ok.txt", "ok\n");

    const r = packDir();

    expect(labels(r)).toEqual(["ok.txt"]);
    expect(r.skipped.binary).toBe(1);
  });
});

describe("pack: lockfiles", () => {
  it("skips package-lock.json", () => {
    put("package-lock.json", "{}\n");
    put("package.json", "{}\n");

    const r = packDir();

    expect(labels(r)).toEqual(["package.json"]);
    expect(r.skipped.lockfile).toBe(1);
  });
});

describe("pack: secret files", () => {
  it("skips .env and key.pem by name, keeps .env.example", () => {
    put(".env", "KEY=1\n");
    put(".env.example", "KEY=\n");
    put("key.pem", "pem\n");
    put("app.ts", "export {}\n");

    const r = packDir();

    expect(labels(r)).toContain(".env.example");
    expect(labels(r)).toContain("app.ts");
    expect(labels(r)).not.toContain(".env");
    expect(labels(r)).not.toContain("key.pem");
  });

  it("skips a file whose content contains a private key block", () => {
    put("notes.txt", `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}\nabc\n`);
    put("app.ts", "export {}\n");

    const r = packDir();

    expect(labels(r)).toEqual(["app.ts"]);
    expect(r.skipped.secret).toBe(1);
  });
});

describe("pack: include and exclude globs", () => {
  it("keeps only files matching include", () => {
    put("src/a.ts", "a\n");
    put("src/b.md", "b\n");
    put("lib/c.ts", "c\n");

    const r = packDir({ include: ["*.ts"] });

    expect(labels(r)).toEqual(["lib/c.ts", "src/a.ts"]);
    expect(r.skipped.not_included).toBe(1);
  });

  it("drops files matching exclude", () => {
    put("src/a.ts", "a\n");
    put("src/gen.gen.ts", "g\n");

    const r = packDir({ exclude: ["**/*.gen.ts"] });

    expect(labels(r)).toEqual(["src/a.ts"]);
    expect(r.skipped.excluded).toBe(1);
  });
});

describe("pack: exclude_tests", () => {
  const seedTests = (): void => {
    put("test/a.ts", "a\n");
    put("src/foo.test.ts", "t\n");
    put("src/foo_test.go", "package x\n");
    put("src/FooTest.java", "class FooTest {}\n");
    put("src/Foo.ts", "export {}\n");
  };

  it("skips test/ directories and test files when excludeTests is true", () => {
    seedTests();

    const r = packDir({ excludeTests: true });

    expect(labels(r)).toEqual(["src/Foo.ts"]);
    expect(r.skipped.test).toBeGreaterThan(0);
  });

  it("keeps test files when excludeTests is false", () => {
    seedTests();

    const r = packDir({ excludeTests: false });

    expect(labels(r)).toEqual(["src/Foo.ts", "src/FooTest.java", "src/foo.test.ts", "src/foo_test.go", "test/a.ts"]);
  });
});

describe("pack: output format", () => {
  it("wraps files in labelled blocks with line numbers by default", () => {
    put("a.ts", "alpha\nbeta");

    const r = packDir();

    expect(r.text).toBe('<file path="a.ts">\n1| alpha\n2| beta\n</file>\n');
  });

  it("emits raw content without line numbers when lineNumbers is false", () => {
    put("a.ts", "alpha\nbeta\n");

    const r = packDir({ lineNumbers: false });

    expect(r.text).toBe('<file path="a.ts">\nalpha\nbeta\n</file>\n');
  });

  it("orders files deterministically by path", () => {
    put("b.ts", "b\n");
    put("a.ts", "a\n");
    put("sub/c.ts", "c\n");

    const r = packDir();

    expect(labels(r)).toEqual(["a.ts", "b.ts", "sub/c.ts"]);
    expect(r.text.indexOf('<file path="a.ts">')).toBeLessThan(r.text.indexOf('<file path="b.ts">'));
    expect(r.text.indexOf('<file path="b.ts">')).toBeLessThan(r.text.indexOf('<file path="sub/c.ts">'));
    expect(r.text.match(/<\/file>/g)).toHaveLength(3);
  });

  it("summarises directories by top-level pair", () => {
    put("src/a.ts", "a\n");
    put("src/b.ts", "b\n");
    put("top.ts", "t\n");

    const dirs = topDirs(packDir().files);

    expect(dirs.map((d) => d.dir).sort()).toEqual([".", "src"]);
    expect(dirs.find((d) => d.dir === "src")?.files).toBe(2);
  });
});

describe("pack: explicit paths", () => {
  it("includes a single explicit file path", () => {
    put("src/one.ts", "one\n");
    put("src/two.ts", "two\n");

    const r = pack({ paths: [join(dir, "src/one.ts")], root: dir });

    expect(labels(r)).toEqual(["src/one.ts"]);
  });

  it("throws for a missing path", () => {
    expect(() => pack({ paths: ["missing.ts"], root: dir })).toThrow("Path not found");
  });

  it("refuses to pack the home directory", () => {
    expect(() => pack({ paths: [homedir()], root: dir })).toThrow(/Refusing to pack/);
  });

  it("refuses to pack the filesystem root", () => {
    expect(() => pack({ paths: ["/"], root: dir })).toThrow(/Refusing to pack/);
  });
});

describe("pack: size limits", () => {
  it("skips files above maxFileBytes as too_large", () => {
    put("big.ts", "x".repeat(100));
    put("small.ts", "y\n");

    const r = packDir({ maxFileBytes: 50 });

    expect(labels(r)).toEqual(["small.ts"]);
    expect(r.skipped.too_large).toBe(1);
  });

  it("throws when total packed content exceeds maxBytes", () => {
    put("a.ts", "a".repeat(200));

    expect(() => packDir({ maxBytes: 100 })).toThrow(/Packed content exceeds/);
  });
});

describe("pack: symlinks", () => {
  it("skips symlinks found while walking a directory", () => {
    put("real.ts", "real\n");
    symlinkSync(join(dir, "real.ts"), join(dir, "link.ts"));

    const r = packDir();

    expect(labels(r)).toEqual(["real.ts"]);
    expect(r.skipped.symlink).toBe(1);
  });
});

describe("tokens", () => {
  it("converts bytes to tokens at 3.2 bytes per token", () => {
    expect(estimateTokensFromBytes(320)).toBe(100);
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(estimateTokens("é".repeat(160))).toBe(100);
  });

  it("throws when input plus max tokens exceeds 95% of the window", () => {
    expect(() => checkWindow(3_000_000, 1_000_000)).toThrow(/Context too large/);
  });

  it("does not throw for small inputs", () => {
    expect(() => checkWindow(1000, 1000)).not.toThrow();
  });

  it("prices prompt, cached prompt and completion tokens", () => {
    const cost = estimateCost({
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 500_000 },
    });

    expect(cost).toBeCloseTo(0.555, 10);
  });
});

describe("pack: globs with slashes and root confinement", () => {
  it("matches include and exclude globs that contain a slash", () => {
    put("src/a.ts");
    put("src/gen/b.ts");
    put("lib/c.ts");
    expect(labels(packDir({ include: ["src/**/*.ts"], exclude: ["src/gen/**"] }))).toEqual(["src/a.ts"]);
  });

  it("rejects paths outside root", () => {
    put("a.ts");
    const outside = mkdtempSync(join(tmpdir(), "savant-out-"));
    try {
      expect(() => pack({ paths: [outside], root: dir })).toThrow(/outside root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

# subq-savant-mcp

MCP server (stdio) and CLI that let an agent ask [SubQ Savant](https://docs.subq.ai) (`subq-savant-1.4`, 4M-token context) questions over a whole codebase or document set.

An agent cannot push 1M tokens through tool arguments. So the server assembles the context itself: you pass a prompt plus local paths, it walks the files, packs them into one request, calls Savant and returns only the answer.

## Tools

| Tool | Purpose |
| --- | --- |
| `savant_ask` | `prompt` + `paths` (+ `root`, `include`, `exclude`, `exclude_tests`, `line_numbers`, `context`, `system`, `reasoning_effort` low/high/max, `max_tokens`, `output_file`, `overwrite`) -> answer + footer (files, token estimate, API usage, cost) |
| `savant_pack_preview` | Dry run, no API call: file list, skipped counts, estimated tokens and input cost |
| `savant_status` | Checks the key and that it can call `subq-savant-1.4` |

Packing rules:

- Respects `.gitignore` (nested too). Skips `.git`, `node_modules`, `dist`, `build`, `target`, `vendor`, lockfiles, binaries, minified files, files over 1 MB, symlinks.
- Skips secret-looking files: `.env*` (except `.env.example`), `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `*.tfstate`, and any file containing a private key, AWS key, GitHub token or similar.
- Each file is sent as `<file path="rel/path">` with `N| ` line prefixes, so answers cite `path:line`.
- Files are sorted by path, so repeated runs share a prompt prefix and benefit from cached-input pricing.
- Paths must stay inside `root` (default: the server's working directory). Set `SUBQ_ALLOWED_ROOTS` (colon-separated) to restrict where `root` may point. `/` and the home directory are refused.
- The request is refused locally if the estimated input plus `max_tokens` exceeds 95% of the 4,194,304-token window. The estimate is bytes/3.2 and was within about 2% on a small sample; `savant_pack_preview` shows it before you pay.

Answers over 60k characters (or any answer with `output_file`) are written to a file (mode 600) and only a preview plus the path is returned. A partial answer from a broken stream is saved the same way.

## Install

```bash
git clone https://github.com/acrossoffwest/subq-savant-mcp.git
cd subq-savant-mcp
npm install      # also builds dist/
npm test
```

Requires Node 20+.

## Token

The server reads `SUBQ_API_KEY` from its environment. Pick one:

1. Export it in the shell you start Claude Code / Codex from (`export SUBQ_API_KEY=...` in `~/.zshrc`, or a file you `source`).
2. Put it in `~/.config/subq-savant-mcp/.env` (outside the repo):

   ```bash
   mkdir -p ~/.config/subq-savant-mcp
   printf 'SUBQ_API_KEY=\n' > ~/.config/subq-savant-mcp/.env
   chmod 600 ~/.config/subq-savant-mcp/.env
   # open the file and paste the key after the =
   ```

`.env.example` in the repo is a placeholder only; `.env` is gitignored. The key is never logged or returned.

## Claude Code

Stdio servers inherit the environment of Claude Code, so a key exported in your shell is picked up. Choose the scope yourself:

```bash
# only this project, only you (default scope "local")
claude mcp add --transport stdio savant -- node /absolute/path/to/subq-savant-mcp/dist/server.js

# shared with the team via .mcp.json in the project (do not put the key there)
claude mcp add --scope project --transport stdio savant -- node /absolute/path/to/subq-savant-mcp/dist/server.js

# every project on this machine
claude mcp add --scope user --transport stdio savant -- node /absolute/path/to/subq-savant-mcp/dist/server.js
```

To pass the key explicitly instead of inheriting: add `--env SUBQ_API_KEY=...` before `savant` (and keep a `--transport stdio` between `--env` and the name). That stores the key in the Claude config, so prefer the environment or the config file.

Long runs: the default tool timeout is about 28 hours. The server sends a progress heartbeat every 15 seconds while Savant works, so the 30-minute stdio idle timeout does not fire. Cap runtime with `MCP_TOOL_TIMEOUT` (ms) or a per-server `"timeout"` in `.mcp.json` (a hard wall-clock limit; progress does not extend it).

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.savant]
command = "node"
args = ["/absolute/path/to/subq-savant-mcp/dist/server.js"]
env_vars = ["SUBQ_API_KEY"]
startup_timeout_sec = 20
tool_timeout_sec = 3600
```

`env_vars` forwards `SUBQ_API_KEY` from the environment Codex was started in (or omit it and use the config file above). `tool_timeout_sec` defaults to 60 seconds, so it must be raised for large contexts. Codex may not send progress tokens; the timeout alone then bounds the call.

CLI equivalent: `codex mcp add savant -- node /absolute/path/to/subq-savant-mcp/dist/server.js` (then add `env_vars` and `tool_timeout_sec` to the config).

## CLI

```bash
node dist/cli.js status
node dist/cli.js preview ~/work/app/src --exclude-tests
node dist/cli.js ask "Which frontend API calls have no matching backend route?" web/src api/src \
  --root ~/work/app --exclude-tests --effort high --output answer.md
```

After `npm link` (or `npm i -g .`) the commands are `subq-savant` and `subq-savant-mcp`.

## Usage examples (as an agent prompt)

- "Use savant_pack_preview on `web/src` and `api/src`, then savant_ask: list every HTTP call in the frontend that has no route in the backend, with file:line on both sides."
- "savant_ask over `src` with exclude_tests: find dead code (exported symbols never referenced) and cross-module bugs."

## Cost and privacy

Pricing: $0.10 per 1M input tokens, $0.01 cached input, $0.50 per 1M output (reasoning counts as output). A 1M-token context costs about $0.10 per question. Every answer ends with a cost footer from the API usage.

Your files are sent to the SubQ API. Requests set `store: false`; SubQ's own retention policy still applies (see their data retention page). Do not point this at code you may not send to a third party.

`max_tokens` covers reasoning plus the answer. If reasoning eats the budget the API returns no text; the tool reports that and suggests a larger `max_tokens` or `reasoning_effort: "low"`.

## Development

```bash
npm run build
npm test
```

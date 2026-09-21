# mcp-remote regression suite

External, end-to-end regression checks that run the **real built proxy** (`dist/proxy.js`) against
controlled local MCP servers. These complement the unit tests in `src/**/*.test.ts`: the unit tests
verify logic with mocked transports, while these runners exercise the shipped binary over real
transports, so they catch integration-level regressions that mocks cannot (SDK internals, real
reconnects, real OAuth round trips).

## Runners

| Script | Covers |
| --- | --- |
| `run-regression.mjs` | Basic Streamable HTTP + legacy SSE smoke checks (`initialize`, `tools/list`, `tools/call`) driven through the MCP Inspector CLI, plus the **#268** custom-header logging check (header *name* is logged, header *value* is never leaked to stderr). |
| `run-sse-reinit-269.mjs` | **#269** — a real `EventSource` reconnect rotates the SSE session, mcp-remote detects the endpoint rotation and replays `initialize` on the new session automatically, and a following `tools/call` succeeds. |
| `run-oauth-midsession-286.mjs` | **#286** — a mid-session HTTP 401 on `tools/call` triggers OAuth recovery; the harness completes the authorize/callback flow headlessly, mcp-remote performs the token exchange, and the originally-failed tool call is retried successfully. |
| `run-all.mjs` | Aggregate runner. Runs the three runners sequentially, streams their output, continues past a failure, prints a PASS/FAIL summary, and exits non-zero if any runner failed. |

## Fixtures

The `fixture-*.mjs` files are small, controlled local MCP servers (Express + the MCP SDK). They are
deterministic by design — each exposes a single `echo` tool and, where a specific failure mode is
needed, injects it on purpose:

- `fixture-http.mjs` — Streamable HTTP MCP server.
- `fixture-sse.mjs` — legacy SSE MCP server.
- `fixture-sse-rotate.mjs` — SSE server that mints a new session per connection and deliberately
  drops the first stream to force a reconnect (#269). Exposes `/debug/state` for assertions.
- `fixture-oauth-mcp.mjs` — combined MCP + OAuth authorization server that returns a single 401 on
  an unauthenticated `tools/call` (#286). Exposes `/debug/state` for assertions.

All tokens and authorization codes are randomly generated in memory per run. No real credentials are
involved, and the runners avoid printing authorize URLs, tokens, codes, or PKCE values.

## Requirements

- **Node >= 22.19.0** — required by `@modelcontextprotocol/inspector@2.6.0`, which
  `run-regression.mjs` uses.
- **IPv6 loopback (`[::1]`)** — the #286 runner addresses the fixture as `http://[::1]:4020/mcp`.
  mcp-remote intentionally skips OAuth for `localhost`/`127.0.0.1`, so IPv6 loopback is what lets the
  OAuth path run at all. If IPv6 loopback is disabled in your environment, that runner will not work.
- **Fixed ports:** `4000` (HTTP fixture), `4001` (SSE fixture), `4002` (rotating SSE fixture),
  `4020` (OAuth + MCP fixture). Each runner fails fast if its port is already in use, so the runners
  must not be executed in parallel.

## Running

From the repository root:

```bash
pnpm --dir test/regression install   # one-time, isolated from the root install
pnpm test:regression                 # builds dist/proxy.js, then runs run-all.mjs
```

Individual runners can be executed directly from this directory, e.g.:

```bash
node run-sse-reinit-269.mjs
```

`MCP_REMOTE_BASE_PATH` can be set to point at a different repository root if `dist/proxy.js` is not
two levels above this directory.

## SSE shutdown warnings

`run-regression.mjs` separately reports SSE shutdown/cleanup noise (for example `UV_HANDLE_CLOSING`
or `AbortError` during teardown) as `SSE CLEANUP RESULT: WARN`. These warnings are **tracked
separately from functional regressions** and do not affect the pass/fail result: the functional
outcome is decided only by the `initialize` / `tools/list` / `tools/call` / #268 assertions.

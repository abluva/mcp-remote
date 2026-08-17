# Abluva fork — changes & upstream alignment

This document describes how **`@abluva/mcp-remote`** relates to upstream [`geelen/mcp-remote`](https://github.com/geelen/mcp-remote), which branches and PRs were incorporated, and which open upstream issues this fork addresses.

**Repository:** [abluva-research/mcp-remote](https://github.com/abluva-research/mcp-remote)  
**npm package:** [`@abluva/mcp-remote`](https://www.npmjs.com/package/@abluva/mcp-remote)  
**Maintainer:** [Abluva Research](https://abluva.com)

---

## Lineage

| Source | What we took |
|--------|----------------|
| **[geelen/mcp-remote](https://github.com/geelen/mcp-remote) `@main` (v0.1.38)** | Full codebase baseline — MCP SDK 1.25.3, HTTP-first transport, OAuth discovery (RFC 9728), lockfile coordination, etc. |
| **[jacopoc/mcp-remote](https://github.com/jacopoc/mcp-remote) branch `implement-reauth-after-auth-error-on-send`** ([PR #213](https://github.com/geelen/mcp-remote/pull/213) — open upstream) | Mid-session re-authentication on auth errors during active MCP sessions (`onSendError`), `reset-auth-code` coordination, auth code reset after resolve |
| **Abluva-specific fixes (v0.1.39–v0.1.42)** | OAuth callback reliability, auto port collision handling, proactive token refresh, JSON-RPC error propagation, proxy-mode `finishAuth` |

We did **not** fork from a random snapshot — the repo history starts at `geelen/mcp-remote@0.1.38` with Abluva commits on top.

---

## Upstream issues addressed

These are **open** on [geelen/mcp-remote](https://github.com/geelen/mcp-remote/issues) but are **fixed or mitigated** in `@abluva/mcp-remote`:

| Issue | Summary | How we address it |
|-------|---------|-------------------|
| [#181](https://github.com/geelen/mcp-remote/issues/181) | Re-issuing OAuth tokens fails (refresh + new grant) | Mid-session `onSendError` → re-auth → `finishAuth` → retry |
| [#286](https://github.com/geelen/mcp-remote/issues/286) | OAuth only on `initialize`; mid-session `tools/call` 401 fails silently | Same mid-session re-auth path; JSON-RPC errors returned to client |
| [#248](https://github.com/geelen/mcp-remote/issues/248) | Runtime re-auth opens browser but callback server never starts | Eager callback server at startup; `waitForCallbackServer` before browser |
| [#245](https://github.com/geelen/mcp-remote/issues/245) | Claude spawns duplicate processes; callback server dies | Dedicated callback server per proxy (`force: true` on startup); reuse listener on re-auth |
| [#256](https://github.com/geelen/mcp-remote/issues/256) | Re-auth loop: code hits localhost but `POST /token` never called | Keep callback listener alive; correct `finishAuth` + `redirect_uri` sync |
| [#91](https://github.com/geelen/mcp-remote/issues/91) | Revoked tokens → infinite auth loop / stuck unauthorized | Clear stale tokens; re-auth flow; connect-time recovery for rejected cached tokens (v2.0.1) |
| [#293](https://github.com/geelen/mcp-remote/issues/293) | Server send errors swallowed — Claude hangs | Pending-request tracking + JSON-RPC error responses ([#297](https://github.com/geelen/mcp-remote/pull/297)) |
| [#273](https://github.com/geelen/mcp-remote/issues/273) | No `expires_at` → silent expiry, broken re-auth | Persist `expires_at`; proactive refresh ~60s before expiry ([#290](https://github.com/geelen/mcp-remote/pull/290)) |
| [#270](https://github.com/geelen/mcp-remote/issues/270) | Token exchange POSTed to resource URL instead of `token_endpoint` | `finishAuth` on transport that received 401 in proxy mode ([#302](https://github.com/geelen/mcp-remote/pull/302)) |
| [#253](https://github.com/geelen/mcp-remote/issues/253) | Stale callback server → EADDRINUSE on reconnect | Bind retry + auto port selection + stale `client_info` invalidation ([#262](https://github.com/geelen/mcp-remote/pull/262) partial) |
| [#306](https://github.com/geelen/mcp-remote/issues/306) | EADDRINUSE concurrent OAuth port collisions | Auto port resolution without explicit config (v0.1.40+); optional explicit port still supported |
| [#301](https://github.com/geelen/mcp-remote/issues/301) | Authorize URL built from wrong origin | Authorization server metadata URL fix (from jacopoc branch) |

---

## Upstream open PRs incorporated (not yet merged on geelen)

| PR | Title | Status in Abluva fork |
|----|-------|------------------------|
| [#213](https://github.com/geelen/mcp-remote/pull/213) | Mid-session re-auth on `UnauthorizedError` during send | **Merged** (via jacopoc branch + Abluva extensions) |
| [#297](https://github.com/geelen/mcp-remote/pull/297) | Propagate server send errors as JSON-RPC errors | **Merged** (v0.1.41) |
| [#290](https://github.com/geelen/mcp-remote/pull/290) | Persist `expires_at` for proactive token refresh | **Merged** (v0.1.41) |
| [#302](https://github.com/geelen/mcp-remote/pull/302) | `finishAuth` on correct transport in proxy mode | **Merged** (v0.1.41) |
| [#262](https://github.com/geelen/mcp-remote/pull/262) | Recover from EADDRINUSE on callback port | **Largely merged** (v0.1.40 auto port + bind retry) |
| [#260](https://github.com/geelen/mcp-remote/pull/260) | Bind callback listener before browser auth | **Largely merged** (eager startup + wait-for-port) |

---

## Upstream PRs **not** merged (yet)

| PR | Title | Why skipped |
|----|-------|-------------|
| [#272](https://github.com/geelen/mcp-remote/pull/272) | Respond to `initialize` immediately; OAuth in background | Large architectural change — avoids Claude’s ~60s initialize timeout but needs dedicated design |
| Others | Transport, proxy, Windows edge cases | Tracked upstream; open PRs may supersede our patches |

---

## Abluva-original changes (not from a single upstream PR)

| Area | Change | Versions |
|------|--------|----------|
| **Mid-session OAuth** | `onSendError` handles `UnauthorizedError`, stale refresh, `InvalidRequestError`; opens browser; retries failed JSON-RPC message | 0.1.39+ |
| **Connect-time stale OAuth** | `401 after successful authentication` at connect → invalidate cached tokens, forced browser re-auth, one reconnect | 2.0.1+ |
| **Eager callback server** | OAuth listener starts before remote connect and stays up for process lifetime | 0.1.39+ |
| **Forced re-auth coordination** | Reuse live listener when possible; `forcePrimary` skips lockfile delegation; never close listener unnecessarily | 0.1.39+ |
| **Auto callback ports** | Per-URL port hashing, bind retry on `EADDRINUSE`, invalidate stale `client_info` when port changes | 0.1.40+ |
| **`authProvider` port sync** | `setCallbackPort()` keeps `redirect_uri` aligned with bound listener | 0.1.42+ |
| **Dedicated startup server** | Always `initializeAuth({ force: true })` in proxy mode (Claude Desktop duplicate-process mitigation) | 0.1.42+ |
| **MCP 2026-07-28 stateless** | `--protocol auto\|legacy\|2026-07-28`; POST-only remote transport; stdio bridge shims for Claude | 2.0.0+ |
| **Local dev OAuth skip** | Skip OAuth callback server for `http://127.0.0.1` / `localhost` MCP URLs | 2.0.0+ |
| **npm packaging** | Scoped package `@abluva/mcp-remote`, `prepack` build, public publishConfig | 0.1.39+ |

---

## Version history (Abluva releases)

| Version | Highlights |
|---------|------------|
| **0.1.39** | Initial Abluva release: jacopoc #213 + callback/re-auth fixes; published as `@abluva/mcp-remote` |
| **0.1.40** | Auto OAuth callback port selection; bind retry; reduce need for explicit ports in Claude config |
| **0.1.41** | Upstream-aligned: #297, #290, #302; regression tests for proxy-mode `finishAuth` |
| **0.1.42** | Stronger auto-port + stale registration invalidation; always-on callback server; `setCallbackPort` sync |
| **2.0.0** | MCP `2026-07-28` stateless remote transport; stdio bridge (initialize shim, `_meta` strip, list-method shims); `--protocol` CLI; localhost OAuth skip; SDK 1.30 |
| **2.0.1** | Connect-time recovery when Obot/gateway rejects cached OAuth (`401 after successful authentication`); opens browser instead of fatal exit |

---

## Usage (Claude Desktop)

**Recommended** — no explicit callback port (auto-selected per MCP server URL):

```json
{
  "mcpServers": {
    "My MCP Server": {
      "command": "npx",
      "args": [
        "-y",
        "@abluva/mcp-remote@latest",
        "https://your-gateway.example/mcp-connect/<catalog-id>"
      ]
    }
  }
}
```

**Multiple MCP servers** — each connect URL gets its own auto port. After upgrading, clear stale OAuth state once:

```bash
rm -rf ~/.mcp-auth
```

Then quit Claude completely (Cmd+Q) and reopen.

**Optional explicit port** — only if you still see callback port collisions:

```json
"args": ["-y", "@abluva/mcp-remote@latest", "https://...", "43756"]
```

Use a **unique port per MCP server** (e.g. `43755`, `43756`).

**Local development:**

```bash
git clone https://github.com/abluva-research/mcp-remote.git
cd mcp-remote && npm install && npm run build
```

```json
"command": "node",
"args": ["/path/to/mcp-remote/dist/proxy.js", "https://your-gateway.example/mcp-connect/<id>"]
```

---

## Testing against Abluva MCP gateway

This fork was developed and tested against the **Abluva MCP filter gateway** (`agent.abluva.com` / Hub OAuth):

- Hub logout → mid-session re-auth
- Hub logout / redeploy → **connect-time** re-auth when cached Obot token is rejected (`401 after successful authentication`, v2.0.1+)
- Short-lived MCP access tokens + refresh
- Multiple MCP servers in one Claude config (SQL Sandbox + Atlassian, etc.)

---

## Contributing / upstreaming

We intend to contribute applicable patches back to [geelen/mcp-remote](https://github.com/geelen/mcp-remote). Until they land upstream, use **`@abluva/mcp-remote`** for production MCP gateway deployments that need reliable OAuth with Claude Desktop.

**Report issues:** [abluva-research/mcp-remote/issues](https://github.com/abluva-research/mcp-remote/issues)

---

## License

Same as upstream: **MIT** (see [LICENSE](LICENSE)).

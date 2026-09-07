# Changelog

All notable changes to `@abluva/mcp-remote` will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
For full upstream issue/PR mapping and detailed rationale behind each fix, see [ABLUVA-FORK.md](./ABLUVA-FORK.md).

## [Unreleased]

## [2.1.0] - 2026-09-07
### Fixed
- Cross-process OAuth coordination when Claude Desktop spawns duplicate `mcp-remote` processes ([#17](https://github.com/abluva/mcp-remote/issues/17)) — exclusive callback-port primary election; secondaries wait for primary tokens instead of racing `code_verifier` / callback writes
- Secondary OAuth token handoff for non-primary processes
- Stale dynamic OAuth client registration after port or callback URL changes — re-register only when this process owns coordination
- OAuth discovery metadata fetch failures behind compressing proxies — disable `Accept-Encoding` on RFC 9728 metadata requests
- Legacy SSE session loss after reconnect — `ReinitAwareSSETransport` re-runs `initialize`; SDK headers preserved across SSE reconnects
- MCP method metadata and startup ordering lost through the HTTP transport proxy
- Response transforms dropped during MCP startup sequencing
- Custom header values (e.g. agent keys) appearing in debug logs — values now redacted

### Added
- No-auth fast path — skip eager OAuth coordination when remote is reachable without authentication
- Regression tests for Issue #17 cross-process OAuth election

## [2.0.1]
### Fixed
- Connect-time recovery when Obot/gateway rejects cached OAuth (`401 after successful authentication`) — invalidate tokens and open browser instead of fatal exit

## [2.0.0]
### Added
- MCP `2026-07-28` stateless remote transport (`--protocol auto|legacy|2026-07-28`)
- POST-only remote transport with stdio bridge shims (`initialize`, `_meta` strip, list-method shims)
- Local dev OAuth skip for `http://127.0.0.1` / `localhost` MCP URLs
- SDK bump to `@modelcontextprotocol/sdk` 1.30

## [0.1.42]
### Added
- Stronger auto-port selection and stale registration invalidation
- Always-on callback server (dedicated startup server, `force: true` in proxy mode)
- `setCallbackPort()` to keep `redirect_uri` synced with the bound listener

## [0.1.41]
### Fixed
- Server send errors swallowed, causing Claude to hang (upstream #293, via #297)
- No `expires_at` tracking causing silent token expiry and broken re-auth (upstream #273, via #290)
- Token exchange POSTed to the wrong endpoint in proxy mode (upstream #270, via #302)

### Added
- Regression tests for proxy-mode `finishAuth`

## [0.1.40]
### Added
- Auto OAuth callback port selection per MCP server URL
- Bind retry on `EADDRINUSE`, reducing need for explicit ports in Claude config (upstream #253, #306)

## [0.1.39]
### Added
- Initial Abluva release, published as `@abluva/mcp-remote`
- Mid-session OAuth re-authentication (`onSendError` handling for `UnauthorizedError`, stale refresh, `InvalidRequestError`), based on jacopoc's branch for upstream PR #213
- Eager callback server — starts before remote connect, stays up for process lifetime
- Forced re-auth coordination — reuse live listener when possible, skip lockfile delegation

### Fixed
- Re-issuing OAuth tokens failing on refresh + new grant (upstream #181)
- Mid-session `tools/call` 401s failing silently — OAuth previously ran only on `initialize` (upstream #286)
- Runtime re-auth opening the browser but callback server never starting (upstream #248)
- Duplicate processes killing the callback server (upstream #245)
- Re-auth loop where the code hit localhost but `/token` was never called (upstream #256)
- Revoked tokens causing infinite auth loops (upstream #91)

# `@abluva/mcp-remote`

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13951/badge)](https://www.bestpractices.dev/projects/13951) ![CodeQL](https://github.com/abluva/mcp-remote/actions/workflows/codeql.yml/badge.svg)
![License](https://img.shields.io/github/license/abluva/mcp-remote)
![npm version](https://img.shields.io/npm/v/@abluva/mcp-remote)

**Abluva-maintained fork** of [`mcp-remote`](https://github.com/geelen/mcp-remote) — a stdio proxy that connects MCP clients (Claude Desktop, Cursor, etc.) to **remote MCP servers with OAuth**.

Use this package when upstream `mcp-remote` hangs on auth, drops mid-session re-login, or refuses OAuth callbacks on `localhost`.

| | |
|---|---|
| **npm** | [`@abluva/mcp-remote`](https://www.npmjs.com/package/@abluva/mcp-remote) |
| **GitHub** | [abluva-research/mcp-remote](https://github.com/abluva-research/mcp-remote) |
| **Upstream base** | [geelen/mcp-remote](https://github.com/geelen/mcp-remote) **v0.1.38** |
| **Also incorporates** | [jacopoc PR #213](https://github.com/geelen/mcp-remote/pull/213) (mid-session re-auth — still open upstream) |

📄 **Full fork changelog, upstream issue/PR mapping, and version history:** [ABLUVA-FORK.md](./ABLUVA-FORK.md)

---

## Why Abluva maintains this fork

Upstream `mcp-remote` is the de facto OAuth bridge for stdio-only MCP clients. Several **critical OAuth bugs remain open** on [geelen/mcp-remote](https://github.com/geelen/mcp-remote/issues) — especially mid-session token expiry, Claude Desktop hangs, and `localhost` callback connection refused.

`@abluva/mcp-remote` merges:

- **jacopoc’s unmerged re-auth branch** ([PR #213](https://github.com/geelen/mcp-remote/pull/213))
- **Selected open upstream PRs** ([#297](https://github.com/geelen/mcp-remote/pull/297), [#290](https://github.com/geelen/mcp-remote/pull/290), [#302](https://github.com/geelen/mcp-remote/pull/302), [#262](https://github.com/geelen/mcp-remote/pull/262) partial)
- **Abluva production fixes** for MCP gateway OAuth (callback server lifetime, auto ports, Hub logout re-auth)

---

## Quick start (Claude Desktop)

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "npx",
      "args": [
        "-y",
        "@abluva/mcp-remote@latest",
        "https://your-mcp-gateway.example/mcp-connect/<catalog-id>"
      ]
    }
  }
}
```

**Direct stateless server (MCP `2026-07-28`, bypass gateway):**

```json
{
  "mcpServers": {
    "sql-sandbox-v2": {
      "command": "npx",
      "args": [
        "-y",
        "@abluva/mcp-remote@latest",
        "--protocol",
        "2026-07-28",
        "--allow-http",
        "http://127.0.0.1:8095/mcp/v2"
      ]
    }
  }
}
```

### Protocol modes (`--protocol`)

| Mode | Behavior |
|------|----------|
| `auto` (default) | Probe remote with `server/discover`; use `2026-07-28` if supported, else legacy |
| `legacy` | Stateful Streamable HTTP (`initialize` + session) — use for Obot/gateway URLs |
| `2026-07-28` | Stateless POST-only transport with `_meta` injection and local `initialize` shim for Claude |

---

- **`-y`** — required for Claude (non-interactive npx install).
- **Callback port** — optional third argument; omitted by default (auto-selected per server URL since v0.1.40).
- **After first install or upgrade:** `rm -rf ~/.mcp-auth` then restart Claude (Cmd+Q).

---

## What we fixed (summary)

| Problem | Upstream refs | Fixed in |
|---------|---------------|----------|
| Claude **hangs** after OAuth / tool errors | [#286](https://github.com/geelen/mcp-remote/issues/286), [#293](https://github.com/geelen/mcp-remote/issues/293) | 0.1.39, 0.1.41 |
| **`refresh_token is invalid`** at startup | [#181](https://github.com/geelen/mcp-remote/issues/181), [#91](https://github.com/geelen/mcp-remote/issues/91) | 0.1.39 |
| **Fatal connect** after stale Obot OAuth (`401 after successful authentication`) | Abluva gateway / Hub logout | 2.0.1 |
| Hub logout → **`localhost` connection refused** on re-auth | [#248](https://github.com/geelen/mcp-remote/issues/248), [#245](https://github.com/geelen/mcp-remote/issues/245) | 0.1.39, 0.1.42 |
| **Port clash** with multiple MCP servers (no explicit port) | [#306](https://github.com/geelen/mcp-remote/issues/306), [#262](https://github.com/geelen/mcp-remote/pull/262) | 0.1.40, 0.1.42 |
| Silent token expiry → browser re-auth loops | [#273](https://github.com/geelen/mcp-remote/issues/273) | 0.1.41 ([#290](https://github.com/geelen/mcp-remote/pull/290)) |
| Token exchange to wrong URL (proxy mode) | [#270](https://github.com/geelen/mcp-remote/issues/270) | 0.1.41 ([#302](https://github.com/geelen/mcp-remote/pull/302)) |
| **Concurrent OAuth** when Claude spawns duplicate processes | [#17](https://github.com/abluva/mcp-remote/issues/17), [#245](https://github.com/geelen/mcp-remote/issues/245) | 2.1.0 |
| **Stale dynamic client registration** after port / callback changes | [#253](https://github.com/geelen/mcp-remote/issues/253) | 2.1.0 |
| **SSE reconnect** drops session / headers after network blip | — | 2.1.0 |
| **Tool call failures** after MCP 2.0 (method metadata / transforms lost) | — | 2.1.0 |
| **Agent keys logged** in custom header debug output | — | 2.1.0 |

See [ABLUVA-FORK.md](./ABLUVA-FORK.md) for the complete table and version notes.

---

## Branches & merges

```
geelen/mcp-remote @ v0.1.38 (main)
        │
        ├── jacopoc/implement-reauth-after-auth-error-on-send  →  mid-session re-auth (#213)
        │
        └── abluva-research/mcp-remote (main)
                ├── v0.1.39  OAuth re-auth + eager callback server
                ├── v0.1.40  Auto callback port / EADDRINUSE recovery
                ├── v0.1.41  #297, #290, #302
                ├── v0.1.42  Stale registration invalidation + port sync
                ├── v2.0.0   MCP 2026-07-28 stateless transport
                ├── v2.0.1   Connect-time stale OAuth recovery
                └── v2.1.0   OAuth coordination (#17), SSE reconnect, MCP metadata fixes
```

---

## Not yet included

- **[PR #272](https://github.com/geelen/mcp-remote/pull/272)** — respond to `initialize` immediately while OAuth runs in background (Claude 60s timeout). Requires larger proxy lifecycle change; tracked for a future release.

---

## Local build

```bash
git clone https://github.com/abluva-research/mcp-remote.git
cd mcp-remote
npm install
npm run build
node dist/proxy.js https://your-gateway.example/mcp-connect/<id>
```

---

## Upstream documentation

The sections below are inherited from upstream `mcp-remote` (usage, headers, transport strategies, etc.). For Abluva-specific OAuth behaviour, prefer [ABLUVA-FORK.md](./ABLUVA-FORK.md).

---

# `mcp-remote` (upstream)

Connect an MCP Client that only supports local (stdio) servers to a Remote MCP Server, with auth support:

**Note: this is a working proof-of-concept** but should be considered **experimental**.

## Why is this necessary?

So far, the majority of MCP servers in the wild are installed locally, using the stdio transport. This has some benefits: both the client and the server can implicitly trust each other as the user has granted them both permission to run. Adding secrets like API keys can be done using environment variables and never leave your machine. And building on `npx` and `uvx` has allowed users to avoid explicit install steps, too.

But there's a reason most software that _could_ be moved to the web _did_ get moved to the web: it's so much easier to find and fix bugs & iterate on new features when you can push updates to all your users with a single deploy.

With the latest MCP [Authorization specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization), we now have a secure way of sharing our MCP servers with the world _without_ running code on user's laptops. Or at least, you would, if all the popular MCP _clients_ supported it yet. Most are stdio-only, and those that _do_ support HTTP+SSE don't yet support the OAuth flows required.

That's where `mcp-remote` comes in. As soon as your chosen MCP client supports remote, authorized servers, you can remove it. Until that time, drop in this one liner and dress for the MCP clients you want!

## Usage

All the most popular MCP clients (Claude Desktop, Cursor & Windsurf) use the following config format:

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "npx",
      "args": [
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse"
      ]
    }
  }
}
```

* If `npx` is producing errors, consider adding `-y` as the first argument to auto-accept the installation of the `@abluva/mcp-remote` package.

```json
      "command": "npx",
      "args": [
        "-y",
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse"
      ]
```

* To force `npx` to always check for an updated version, add the `@latest` flag:

```json
      "args": [
        "-y",
        "@abluva/mcp-remote@latest",
        "https://remote.mcp.server/sse"
      ]
```

* To change which port `@abluva/mcp-remote` listens for an OAuth redirect (by default auto-selected per server URL since v0.1.40), add an additional argument after the server URL. If the port is unavailable, an open port will be chosen at random.

```json
      "args": [
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse",
        "9696"
      ]
```

* To change which host `@abluva/mcp-remote` registers as the OAuth callback URL (by default `localhost`), add the `--host` flag.

```json
      "args": [
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse",
        "--host",
        "127.0.0.1"
      ]
```

* To allow HTTP connections in trusted private networks, add the `--allow-http` flag. Note: This should only be used in secure private networks where traffic cannot be intercepted.

```json
      "args": [
        "@abluva/mcp-remote",
        "http://internal-service.vpc/sse",
        "--allow-http"
      ]
```

* To enable detailed debugging logs, add the `--debug` flag. This will write verbose logs to `~/.mcp-auth/{server_hash}_debug.log` with timestamps and detailed information about the auth process, connections, and token refreshing.

```json
      "args": [
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse",
        "--debug"
      ]
```

* To suppress default logs, add the `--silent` flag. This will prevent logs from being emitted, except in the case where `--debug` is also passed.

```json
      "args": [
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse",
        "--silent"
      ]
```

* To enable an outbound HTTP(S) proxy for mcp-remote, add the `--enable-proxy` flag. When enabled, mcp-remote will use the proxy settings from common environment variables (for example `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`).

```json
    "args": [
      "@abluva/mcp-remote",
      "https://remote.mcp.server/sse",
      "--enable-proxy"
    ],
    "env": {
      "HTTPS_PROXY": "http://127.0.0.1:3128",
      "NO_PROXY": "localhost,127.0.0.1"
    }
```

* To ignore specific tools from the remote server, add the `--ignore-tool` flag. This will filter out tools matching the specified patterns from both `tools/list` responses and block `tools/call` requests. Supports wildcard patterns with `*`.

```json
      "args": [
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse",
        "--ignore-tool",
        "delete*",
        "--ignore-tool",
        "remove*"
      ]
```

You can specify multiple `--ignore-tool` flags to ignore different patterns. Examples:
- `delete*` - ignores all tools starting with "delete" (e.g., `deleteTask`, `deleteUser`)
- `*account` - ignores all tools ending with "account" (e.g., `getAccount`, `updateAccount`)
- `exactTool` - ignores only the tool named exactly "exactTool"

* To change the timeout for the OAuth callback (by default `30` seconds), add the `--auth-timeout` flag with a value in seconds. This is useful if the authentication process on the server side takes a long time.

```json
      "args": [
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse",
        "--auth-timeout",
        "60"
      ]
```

### Transport Strategies

MCP Remote supports different transport strategies when connecting to an MCP server. This allows you to control whether it uses Server-Sent Events (SSE) or HTTP transport, and in what order it tries them.

Specify the transport strategy with the `--transport` flag:

```bash
npx @abluva/mcp-remote https://example.remote/server --transport sse-only
```

**Available Strategies:**

- `http-first` (default): Tries HTTP transport first, falls back to SSE if HTTP fails with a 404 error
- `sse-first`: Tries SSE transport first, falls back to HTTP if SSE fails with a 405 error
- `http-only`: Only uses HTTP transport, fails if the server doesn't support it
- `sse-only`: Only uses SSE transport, fails if the server doesn't support it

### Static OAuth Client Metadata

MCP Remote supports providing static OAuth client metadata instead of using the mcp-remote defaults.
This is useful when connecting to OAuth servers that expect specific client/software IDs or scopes.

Provide the client metadata as a JSON string or as a `@` prefixed filepath with the `--static-oauth-client-metadata` flag:

```bash
npx @abluva/mcp-remote https://example.remote/server --static-oauth-client-metadata '{ "scope": "space separated scopes" }'
# uses node readfile, so you probably want to use absolute paths if you're not sure what the cwd is
npx @abluva/mcp-remote https://example.remote/server --static-oauth-client-metadata '@/Users/username/Library/Application Support/Claude/oauth_client_metadata.json'
```

### Static OAuth Client Information

Per the [spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization#2-4-dynamic-client-registration),
servers are encouraged but not required to support [OAuth dynamic client registration](https://datatracker.ietf.org/doc/html/rfc7591).

For these servers, MCP Remote supports providing static OAuth client information instead.
This is useful when connecting to OAuth servers that require pre-registered clients.

Provide the client metadata as a JSON string or as a `@` prefixed filepath with the `--static-oauth-client-info` flag:

```bash
export MCP_REMOTE_CLIENT_ID=xxx
export MCP_REMOTE_CLIENT_SECRET=yyy
npx @abluva/mcp-remote https://example.remote/server --static-oauth-client-info "{ \"client_id\": \"$MCP_REMOTE_CLIENT_ID\", \"client_secret\": \"$MCP_REMOTE_CLIENT_SECRET\" }"
# uses node readfile, so you probably want to use absolute paths if you're not sure what the cwd is
npx @abluva/mcp-remote https://example.remote/server --static-oauth-client-info '@/Users/username/Library/Application Support/Claude/oauth_client_info.json'
```

### Claude Desktop

[Official Docs](https://modelcontextprotocol.io/quickstart/user)

In order to add an MCP server to Claude Desktop you need to edit the configuration file located at:

* macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
* Windows: `%APPDATA%\Claude\claude_desktop_config.json`

If it does not exist yet, [you may need to enable it under Settings > Developer](https://modelcontextprotocol.io/quickstart/user#2-add-the-filesystem-mcp-server).

Restart Claude Desktop to pick up the changes in the configuration file.
Upon restarting, you should see a hammer icon in the bottom right corner
of the input box.

### Cursor

[Official Docs](https://docs.cursor.com/context/model-context-protocol). The configuration file is located at `~/.cursor/mcp.json`.

As of version `0.48.0`, Cursor supports unauthed SSE servers directly. If your MCP server is using the official MCP OAuth authorization protocol, you still need to add a **"command"** server and call `@abluva/mcp-remote`.

### Windsurf

[Official Docs](https://docs.codeium.com/windsurf/mcp). The configuration file is located at `~/.codeium/windsurf/mcp_config.json`.

## Building Remote MCP Servers

For instructions on building & deploying remote MCP servers, including acting as a valid OAuth client, see the following resources:

* https://developers.cloudflare.com/agents/guides/remote-mcp-server/

In particular, see:

* https://github.com/cloudflare/workers-oauth-provider for defining an MCP-comlpiant OAuth server in Cloudflare Workers
* https://github.com/cloudflare/agents/tree/main/examples/mcp for defining an `McpAgent` using the [`agents`](https://npmjs.com/package/agents) framework.

For more information about testing these servers, see also:

* https://developers.cloudflare.com/agents/guides/test-remote-mcp-server/

Know of more resources you'd like to share? Please add them to this Readme and send a PR!

## Troubleshooting

### Clear your `~/.mcp-auth` directory

`@abluva/mcp-remote` stores all the credential information inside `~/.mcp-auth` (or wherever your `MCP_REMOTE_CONFIG_DIR` points to). If you're having persistent issues, try running:

```sh
rm -rf ~/.mcp-auth
```

Then restarting your MCP client.

### Check your Node version

Make sure that the version of Node you have installed is [18 or
higher](https://modelcontextprotocol.io/quickstart/server). Claude
Desktop will use your system version of Node, even if you have a newer
version installed elsewhere.

### Restart Claude

When modifying `claude_desktop_config.json` it can helpful to completely restart Claude

### VPN Certs

You may run into issues if you are behind a VPN, you can try setting the `NODE_EXTRA_CA_CERTS`
environment variable to point to the CA certificate file. If using `claude_desktop_config.json`,
this might look like:

```json
{
 "mcpServers": {
    "remote-example": {
      "command": "npx",
      "args": [
        "@abluva/mcp-remote",
        "https://remote.mcp.server/sse"
      ],
      "env": {
        "NODE_EXTRA_CA_CERTS": "{your CA certificate file path}.pem"
      }
    }
  }
}
```

### Check the logs

* [Follow Claude Desktop logs in real-time](https://modelcontextprotocol.io/docs/tools/debugging#debugging-in-claude-desktop)
* MacOS / Linux:<br/>`tail -n 20 -F ~/Library/Logs/Claude/mcp*.log`
* For bash on WSL:<br/>`tail -n 20 -f "C:\Users\YourUsername\AppData\Local\Claude\Logs\mcp.log"`
* Powershell: <br/>`Get-Content "C:\Users\YourUsername\AppData\Local\Claude\Logs\mcp.log" -Wait -Tail 20`

## Debugging

### Debug Logs

For troubleshooting complex issues, especially with token refreshing or authentication problems, use the `--debug` flag:

```json
"args": [
  "@abluva/mcp-remote",
  "https://remote.mcp.server/sse",
  "--debug"
]
```

This creates detailed logs in `~/.mcp-auth/{server_hash}_debug.log` with timestamps and complete information about every step of the connection and authentication process. When you find issues with token refreshing, laptop sleep/resume issues, or auth problems, provide these logs when seeking support.

### Authentication Errors

If you encounter the following error, returned by the `/callback` URL:

```
Authentication Error
Token exchange failed: HTTP 400
```

You can run `rm -rf ~/.mcp-auth` to clear any locally stored state and tokens.

### "Client" mode

Run the following on the command line (not from an MCP server):

```shell
npx -p @abluva/mcp-remote@latest mcp-remote-client https://remote.mcp.server/sse
```

This will run through the entire authorization flow and attempt to list the tools & resources at the remote URL. Try this after running `rm -rf ~/.mcp-auth` to see if stale credentials are your problem, otherwise hopefully the issue will be more obvious in these logs than those in your MCP client.

import express from 'express'
import { randomUUID, createHash } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

/**
 * Combined OAuth + MCP fixture for the issue #286 mid-session re-auth regression.
 *
 * Bound to IPv6 loopback [::1] so mcp-remote does NOT treat it as a local no-OAuth
 * server (isLocalHttpServer only matches literal localhost / 127.0.0.1). Run the proxy
 * against it with --allow-http.
 *
 * Behavior:
 *  - GET  /mcp (no mcp-session-id)  -> 200 (discovery probe => serverAccessibleWithoutAuth,
 *                                       so there is NO OAuth/browser at connect).
 *  - POST /mcp initialize/tools/list/notifications -> served WITHOUT a token.
 *  - POST /mcp tools/call WITHOUT a valid Bearer token -> single HTTP 401 (mid-session).
 *  - OAuth endpoints: metadata, /authorize, /token (shared issued-token set).
 *  - GET  /debug/state -> assertion snapshot.
 *
 * /authorize is opt-in: it only auto-approves and redirects with a code when
 * AUTHORIZE_REDIRECT=1 is set (the harness sets it). Without that env var it stays inert
 * and returns 200, so an incidental OS browser hitting the URL cannot complete the flow.
 */

const PORT = Number(process.env.FIXTURE_PORT || 4020)
const HOST = '::1'
const BASE = `http://[${HOST}]:${PORT}`
const AUTHORIZE_REDIRECT = process.env.AUTHORIZE_REDIRECT === '1'

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// --- MCP session registry (StreamableHTTP) ---
const transports = new Map() // sessionId -> StreamableHTTPServerTransport

// --- OAuth state ---
const codes = new Map() // code -> { clientId, redirectUri, state, codeChallenge }
const issuedTokens = new Set() // valid bearer tokens

const state = {
  served401: 0,
  authorizeHits: 0,
  tokenExchanged: false,
  issuedTokens: 0,
  bearerAcceptedForToolCall: false,
  lastAuthorize: null,
  mcpMethods: [],
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function hasValidToken(req) {
  const h = req.headers['authorization']
  return typeof h === 'string' && h.startsWith('Bearer ') && issuedTokens.has(h.slice(7))
}

function createServer() {
  const server = new McpServer({
    name: 'mcp-remote-regression-oauth-fixture',
    version: '1.0.0',
  })
  server.tool('echo', 'Returns the supplied text unchanged', { text: z.string() }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }))
  return server
}

// -----------------------------------------------------
// MCP endpoint
// -----------------------------------------------------

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id']
  if (!sessionId) {
    // OAuth discovery probe: report reachable without auth.
    res.status(200).json({ status: 'ok' })
    return
  }
  const transport = transports.get(sessionId)
  if (!transport) {
    res.status(400).send('Unknown MCP session')
    return
  }
  await transport.handleRequest(req, res)
})

app.post('/mcp', async (req, res) => {
  try {
    const method = req.body?.method
    if (typeof method === 'string') state.mcpMethods.push(method)

    // Mid-session auth gate: a tools/call without a valid token gets a single 401.
    if (method === 'tools/call' && !hasValidToken(req)) {
      state.served401++
      res
        .status(401)
        .set('WWW-Authenticate', `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`)
        .json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32001, message: 'unauthorized' } })
      return
    }

    // A tools/call that reaches here with a valid token proves the MCP endpoint observed
    // the re-issued bearer (the #286 recovery outcome).
    if (method === 'tools/call' && hasValidToken(req)) {
      state.bearerAcceptedForToolCall = true
    }

    const sessionId = req.headers['mcp-session-id']
    let transport

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)
    } else if (!sessionId) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport)
          console.log(`MCP session initialized: ${id}`)
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId)
      }
      const server = createServer()
      await server.connect(transport)
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unknown MCP session' },
        id: null,
      })
      return
    }

    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    console.error('Fixture MCP error:', error)
    if (!res.headersSent) res.status(500).send('Internal fixture error')
  }
})

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id']
  const transport = sessionId && transports.get(sessionId)
  if (!transport) {
    res.status(400).send('Unknown MCP session')
    return
  }
  await transport.handleRequest(req, res)
})

// -----------------------------------------------------
// OAuth endpoints
// -----------------------------------------------------

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: BASE,
    authorization_endpoint: `${BASE}/authorize`,
    token_endpoint: `${BASE}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp'],
  })
})

app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, state: st, code_challenge } = req.query
  if (response_type !== 'code' || !client_id || !redirect_uri) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  state.authorizeHits++
  state.lastAuthorize = {
    clientId: client_id,
    redirectUri: redirect_uri,
    state: st ?? null,
    codeChallenge: code_challenge ?? null,
  }

  if (!AUTHORIZE_REDIRECT) {
    // Inert mode: never delivers a code, so the flow cannot complete.
    res.status(200).send('authorization pending (inert authorize endpoint)')
    return
  }

  // Enabled via AUTHORIZE_REDIRECT=1: auto-approve and redirect with a code.
  const code = randomUUID()
  codes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    state: st,
    codeChallenge: code_challenge,
  })
  const loc = new URL(String(redirect_uri))
  loc.searchParams.set('code', code)
  if (st !== undefined) loc.searchParams.set('state', String(st))
  res.redirect(302, loc.toString())
})

app.post('/token', (req, res) => {
  const { grant_type, code, code_verifier } = req.body ?? {}
  if (grant_type !== 'authorization_code' || !code || !codes.has(code)) {
    res.status(400).json({ error: 'invalid_grant' })
    return
  }
  const entry = codes.get(code)
  codes.delete(code)
  let verifierOk = true
  if (entry.codeChallenge) {
    const computed = b64url(
      createHash('sha256')
        .update(code_verifier ?? '')
        .digest(),
    )
    verifierOk = computed === entry.codeChallenge
  }
  if (!verifierOk) {
    res.status(400).json({ error: 'invalid_grant', detail: 'pkce' })
    return
  }
  const accessToken = `tok-${randomUUID()}`
  issuedTokens.add(accessToken)
  state.tokenExchanged = true
  state.issuedTokens++
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: `ref-${randomUUID()}`,
  })
})

app.get('/debug/state', (_req, res) => {
  res.json(state)
})

const server = app.listen(PORT, HOST, () => {
  console.log(`OAuth+MCP fixture listening on ${BASE}/mcp (authorizeRedirect=${AUTHORIZE_REDIRECT})`)
})

function shutdown() {
  try {
    server.close()
  } catch {
    // ignore
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

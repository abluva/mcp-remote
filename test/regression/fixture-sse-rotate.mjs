import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { z } from 'zod'

/**
 * Rotating SSE fixture for the issue #269 regression.
 *
 * Purpose: force the SDK client's EventSource to reconnect onto a NEW MCP session,
 * so we can observe that mcp-remote automatically replays `initialize` on the
 * rotated session (the client only ever calls connect() once).
 *
 * Mechanics:
 *  - Each GET /sse mints a fresh SSEServerTransport (new sessionId) and is assigned
 *    a monotonically increasing `ordinal` (1 = S1, 2 = S2, ...).
 *  - Every POST /messages records the JSON-RPC `method` into that session's ordered
 *    `methods[]` (diagnostics + assertions), then hands the body to the SDK transport.
 *  - Causal rotation trigger (no timers): the FIRST time session S1 receives
 *    `notifications/initialized`, we end its SSE response. The client's EventSource
 *    then reconnects to /sse, minting S2. Only S1 is ever dropped (guarded), so there
 *    is no reconnect loop.
 *  - GET /debug/state exposes per-session { ordinal, sessionId, initialized, methods }
 *    so the harness can gate on observable readiness instead of sleeping.
 */

const PORT = 4002

const app = express()
app.use(express.json())

/**
 * sessions: Map<sessionId, {
 *   ordinal, sessionId, transport, sseRes,
 *   initialized, methods: string[], dropped
 * }>
 */
const sessions = new Map()
let ordinalCounter = 0

function createServer() {
  const server = new McpServer({
    name: 'mcp-remote-regression-sse-rotate-fixture',
    version: '1.0.0',
  })

  server.tool('echo', 'Returns the supplied text unchanged', { text: z.string() }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }))

  return server
}

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res)
  const ordinal = ++ordinalCounter

  const rec = {
    ordinal,
    sessionId: transport.sessionId,
    transport,
    sseRes: res,
    initialized: false,
    methods: [],
    dropped: false,
  }
  sessions.set(transport.sessionId, rec)

  // Swallow post-close write errors when we deliberately end S1's stream.
  transport.onerror = () => {}

  // Keep the record in `sessions` after the stream closes so /debug/state can still
  // report this session's ordinal and method order. There is no need to unlink it from
  // POST routing: no further POSTs arrive for a closed session.
  transport.onclose = () => {
    rec.closed = true
  }

  const server = createServer()
  await server.connect(transport)

  console.log(`SSE session opened: ordinal=${ordinal} id=${transport.sessionId}`)
})

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId
  const rec = sessions.get(sessionId)

  if (!rec) {
    res.status(400).send('Unknown SSE session')
    return
  }

  const method = req.body?.method
  if (typeof method === 'string') {
    rec.methods.push(method)
    if (method === 'initialize') {
      rec.initialized = true
    }
  }

  await rec.transport.handlePostMessage(req, res, req.body)

  // Causal rotation trigger: once S1 completes its handshake, drop its SSE stream
  // so the client's EventSource reconnects and rotates onto a new session.
  if (method === 'notifications/initialized' && rec.ordinal === 1 && !rec.dropped) {
    rec.dropped = true
    console.log(`Dropping S1 SSE stream to force reconnect: id=${rec.sessionId}`)
    // nextTick (not a timer): only ensures the POST 200 has been flushed first.
    process.nextTick(() => {
      try {
        rec.sseRes.end()
      } catch {
        // ignore
      }
    })
  }
})

app.get('/debug/state', (_req, res) => {
  const list = [...sessions.values()]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ ordinal, sessionId, initialized, methods }) => ({
      ordinal,
      sessionId,
      initialized,
      methods,
    }))
  res.json({ sessions: list })
})

const httpServer = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Rotating SSE fixture listening on http://127.0.0.1:${PORT}/sse`)
})

function shutdown() {
  try {
    httpServer.close()
  } catch {
    // ignore
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

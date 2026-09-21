import express from 'express'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const app = express()
app.use(express.json())

const transports = new Map()

function createServer() {
  const server = new McpServer({
    name: 'mcp-remote-regression-fixture',
    version: '1.0.0',
  })

  server.tool(
    'echo',
    'Returns the supplied text unchanged',
    {
      text: z.string(),
    },
    async ({ text }) => ({
      content: [
        {
          type: 'text',
          text,
        },
      ],
    }),
  )

  return server
}

app.post('/mcp', async (req, res) => {
  try {
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
        if (transport.sessionId) {
          transports.delete(transport.sessionId)
        }
      }

      const server = createServer()
      await server.connect(transport)
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unknown MCP session',
        },
        id: null,
      })
      return
    }

    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    console.error('Fixture error:', error)
    if (!res.headersSent) {
      res.status(500).send('Internal fixture error')
    }
  }
})

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id']

  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Missing or unknown MCP session')
    return
  }

  await transports.get(sessionId).handleRequest(req, res)
})

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id']

  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Missing or unknown MCP session')
    return
  }

  await transports.get(sessionId).handleRequest(req, res)
})

app.listen(4000, '127.0.0.1', () => {
  console.log('Fixture MCP server listening on http://127.0.0.1:4000/mcp')
})

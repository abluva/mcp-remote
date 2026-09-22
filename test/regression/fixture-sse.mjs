import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { z } from 'zod'

const app = express()
app.use(express.json())

const transports = new Map()

function createServer() {
  const server = new McpServer({
    name: 'mcp-remote-regression-sse-fixture',
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

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res)

  transports.set(transport.sessionId, transport)

  transport.onclose = () => {
    transports.delete(transport.sessionId)
  }

  const server = createServer()
  await server.connect(transport)

  console.log(`SSE session opened: ${transport.sessionId}`)
})

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId
  const transport = transports.get(sessionId)

  if (!transport) {
    res.status(400).send('Unknown SSE session')
    return
  }

  await transport.handlePostMessage(req, res, req.body)
})

app.listen(4001, '127.0.0.1', () => {
  console.log('Fixture SSE MCP server listening on http://127.0.0.1:4001/sse')
})

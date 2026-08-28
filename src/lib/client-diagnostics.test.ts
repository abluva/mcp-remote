import { describe, it, expect, vi, beforeEach } from 'vitest'
import { attachClientDiagnostics } from './client-diagnostics'
import { log } from './utils'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListToolsRequestSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

// Mock only the `log` export from utils; keep everything else intact so the
// helper under test uses a spy-able logger via the same live binding it imports.
vi.mock('./utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils')>()
  return { ...actual, log: vi.fn() }
})

const logMock = log as unknown as ReturnType<typeof vi.fn>

/**
 * Regression tests for issue #324.
 *
 * The client entry point used to overwrite `transport.onmessage` with a logging-only
 * handler AFTER `Client.connect()` had installed the SDK response dispatcher there.
 * That discarded every dispatched response, so `client.request(...)` hung until the
 * 60s SDK timeout (-32001). These tests prove `attachClientDiagnostics` keeps the
 * dispatcher intact while still logging messages and wiring close/error diagnostics.
 */
describe('Feature: attachClientDiagnostics preserves the SDK response dispatcher (#324)', () => {
  beforeEach(() => {
    logMock.mockClear()
  })

  /** Builds a fake transport whose onmessage mimics the SDK dispatcher installed by connect(). */
  function makeConnected() {
    const dispatched: JSONRPCMessage[] = []
    const transport = {
      // This is what Client.connect() would have installed: the response dispatcher.
      onmessage: (message: JSONRPCMessage) => {
        dispatched.push(message)
      },
    } as unknown as Transport

    const client = {} as Client
    return { client, transport, dispatched }
  }

  it('Scenario: a tools/list response still reaches the SDK dispatcher after diagnostics attach', () => {
    // Given a connected transport with the SDK dispatcher installed
    const { client, transport, dispatched } = makeConnected()

    // When diagnostics are attached and a tools/list response arrives
    attachClientDiagnostics(client, transport, { onClose: () => {} })
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'array_test' }] },
    } as unknown as JSONRPCMessage
    transport.onmessage!(response)

    // Then the original dispatcher STILL received the response (so client.request would settle)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toEqual(response)
  })

  it('Scenario: received messages are still logged', () => {
    // Given a connected transport
    const { client, transport } = makeConnected()

    // When a message is received after diagnostics attach
    attachClientDiagnostics(client, transport, { onClose: () => {} })
    const message = { jsonrpc: '2.0', id: 2, result: { resources: [] } } as unknown as JSONRPCMessage
    transport.onmessage!(message)

    // Then it is logged with the "Received message:" prefix
    expect(logMock).toHaveBeenCalledWith('Received message:', JSON.stringify(message, null, 2))
  })

  it('Scenario: the dispatcher is chained, not replaced (both logging and settling happen)', () => {
    // Given a connected transport
    const { client, transport, dispatched } = makeConnected()

    // When diagnostics attach and two messages arrive
    attachClientDiagnostics(client, transport, { onClose: () => {} })
    const a = { jsonrpc: '2.0', id: 1, result: {} } as unknown as JSONRPCMessage
    const b = { jsonrpc: '2.0', id: 2, result: {} } as unknown as JSONRPCMessage
    transport.onmessage!(a)
    transport.onmessage!(b)

    // Then every message is both logged and dispatched
    expect(dispatched).toEqual([a, b])
    expect(logMock).toHaveBeenCalledTimes(2)
  })

  it('Scenario: error diagnostics are routed through client.onerror', () => {
    // Given a connected transport
    const { client, transport } = makeConnected()

    // When diagnostics attach
    attachClientDiagnostics(client, transport, { onClose: () => {} })

    // Then client.onerror is installed and logs when invoked (transport handlers untouched)
    expect(typeof client.onerror).toBe('function')
    const err = new Error('boom')
    client.onerror!(err)
    expect(logMock).toHaveBeenCalledWith('Transport error:', err)
  })

  it('Scenario: close diagnostics are routed through client.onclose and invoke the close hook', () => {
    // Given a connected transport and an injected close hook (avoids process.exit in tests)
    const { client, transport } = makeConnected()
    const onClose = vi.fn()

    // When diagnostics attach and the connection closes
    attachClientDiagnostics(client, transport, { onClose })
    expect(typeof client.onclose).toBe('function')
    client.onclose!()

    // Then the close is logged and the hook fires
    expect(logMock).toHaveBeenCalledWith('Connection closed.')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Scenario: diagnostics do not require a pre-existing dispatcher (no throw if absent)', () => {
    // Given a transport with no onmessage yet
    const client = {} as Client
    const transport = {} as Transport

    // When diagnostics attach and a message arrives
    attachClientDiagnostics(client, transport, { onClose: () => {} })

    // Then invoking onmessage logs and does not throw despite no downstream dispatcher
    expect(() => transport.onmessage!({ jsonrpc: '2.0', id: 1, result: {} } as unknown as JSONRPCMessage)).not.toThrow()
  })
})

/**
 * Integration-style regression test against a REAL linked SDK Client/Server pair
 * (upstream #334 style). This proves the fix end-to-end: after diagnostics are
 * attached post-connect, the SDK dispatcher still settles client.request(...).
 * A short per-request timeout ensures a regression fails fast (~1s) instead of
 * hanging for the 60s SDK default.
 */
describe('Feature: attachClientDiagnostics with a real linked SDK transport (#324 end-to-end)', () => {
  beforeEach(() => {
    logMock.mockClear()
  })

  it('Scenario: client.request(tools/list) resolves after diagnostics attach', async () => {
    // Given a real Server exposing tools/list, linked to a real Client via in-memory transport
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    const server = new Server({ name: 'diag-itest-server', version: '0.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'array_test', description: 'noop', inputSchema: { type: 'object', properties: {} } }],
    }))

    const client = new Client({ name: 'diag-itest-client', version: '0.0.0' }, { capabilities: {} })

    // client.connect() installs the SDK response dispatcher on clientTransport.onmessage
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    // When diagnostics attach AFTER connect (the exact ordering that triggered #324)
    attachClientDiagnostics(client, clientTransport, { onClose: () => {} })

    // Then the request RESOLVES (a regression would reject with -32001 at the 1s timeout)
    const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema, { timeout: 1000 })
    expect(result.tools.map((t) => t.name)).toContain('array_test')

    // And the diagnostic logging still fired for the received response
    expect(logMock).toHaveBeenCalledWith('Received message:', expect.stringContaining('array_test'))

    await client.close()
  })
})

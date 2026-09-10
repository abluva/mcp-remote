import { describe, it, expect } from 'vitest'
import {
  buildSyntheticInitializeResult,
  injectRequestMeta,
  PROTOCOL_2026_07_28,
  isNonFatalSseDisconnect,
  sanitizeCallToolResultForStdioClient,
  stripStatelessWireMeta,
} from './stateless-protocol'

describe('stateless-protocol', () => {
  it('injectRequestMeta adds _meta to params', () => {
    const msg = injectRequestMeta(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      {
        protocolVersion: PROTOCOL_2026_07_28,
        clientInfo: { name: 'test', version: '1.0.0' },
        clientCapabilities: { tools: {} },
      },
    )
    expect(msg.params?._meta?.['io.modelcontextprotocol/protocolVersion']).toBe(PROTOCOL_2026_07_28)
  })

  it('buildSyntheticInitializeResult echoes client version when shimming for Claude', () => {
    const result = buildSyntheticInitializeResult(
      {
        protocolVersion: PROTOCOL_2026_07_28,
        supportedProtocolVersions: [PROTOCOL_2026_07_28],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sandbox', version: '1.2.0' },
      },
      '2025-11-25',
      { shimForLocalClient: true },
    )
    expect(result.protocolVersion).toBe('2025-11-25')
    expect(result.serverInfo.name).toBe('sandbox')
  })

  it('buildSyntheticInitializeResult prefers requested version when supported', () => {
    const result = buildSyntheticInitializeResult(
      {
        protocolVersion: PROTOCOL_2026_07_28,
        supportedProtocolVersions: [PROTOCOL_2026_07_28, '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: 'sandbox', version: '1.2.0' },
      },
      '2025-11-25',
    )
    expect(result.protocolVersion).toBe('2025-11-25')
    expect(result.serverInfo.name).toBe('sandbox')
  })

  it('isNonFatalSseDisconnect when idle', () => {
    expect(isNonFatalSseDisconnect(new Error('SSE stream disconnected: terminated'), 0)).toBe(true)
    expect(isNonFatalSseDisconnect(new Error('SSE stream disconnected: terminated'), 1)).toBe(false)
  })

  it('stripStatelessWireMeta removes _meta from result objects', () => {
    const stripped = stripStatelessWireMeta({
      tools: [{ name: 'run_sql' }],
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'x', version: '1' } },
    })
    expect(stripped).toEqual({ tools: [{ name: 'run_sql' }] })
    expect('_meta' in stripped).toBe(false)
  })

  it('sanitizeCallToolResultForStdioClient drops array structuredContent for Claude compatibility', () => {
    const sanitized = sanitizeCallToolResultForStdioClient({
      isError: false,
      content: [{ type: 'text', text: '[{"id":"site-1"}]' }],
      structuredContent: [{ id: 'site-1' }],
      _meta: { _abluva: { decision: 'allowed-post' } },
    })
    expect(sanitized.structuredContent).toBeUndefined()
    expect(sanitized.content).toEqual([{ type: 'text', text: '[{"id":"site-1"}]' }])
    expect(sanitized._meta).toBeUndefined()
  })

  it('sanitizeCallToolResultForStdioClient keeps object structuredContent', () => {
    const sanitized = sanitizeCallToolResultForStdioClient({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { id: 'site-1' },
    })
    expect(sanitized.structuredContent).toEqual({ id: 'site-1' })
  })
})

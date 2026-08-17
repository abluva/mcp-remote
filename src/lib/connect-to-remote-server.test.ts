import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => ({
  httpTransports: [] as Array<{ start: ReturnType<typeof vi.fn>; finishAuth: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  connectFailuresRemaining: 1,
  connectError: null as Error | null,
}))

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  auth: vi.fn().mockResolvedValue('REDIRECT'),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPError extends Error {
    code?: number
    constructor(code: number, message: string) {
      super(message)
      this.code = code
    }
  }
  class StreamableHTTPClientTransport {
    start = vi.fn().mockResolvedValue(undefined)
    finishAuth = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    constructor(
      public url: URL,
      public opts: unknown,
    ) {
      mockState.httpTransports.push(this)
    }
  }
  return { StreamableHTTPClientTransport, StreamableHTTPError }
})

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  class SSEClientTransport {
    start = vi.fn().mockResolvedValue(undefined)
    finishAuth = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    constructor(
      public url: URL,
      public opts: unknown,
    ) {}
  }
  return { SSEClientTransport }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client {
    constructor(
      public info: unknown,
      public caps: unknown,
    ) {}
    async connect() {
      if (mockState.connectFailuresRemaining > 0) {
        mockState.connectFailuresRemaining--
        throw mockState.connectError ?? new Error('Unauthorized')
      }
    }
  }
  return { Client }
})

import { connectToRemoteServer, isStalePostAuth401Error } from './utils'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { auth as runMcpOAuthAuth } from '@modelcontextprotocol/sdk/client/auth.js'

describe('isStalePostAuth401Error', () => {
  it('matches StreamableHTTPError 401 after successful authentication', () => {
    expect(
      isStalePostAuth401Error(new StreamableHTTPError(401, 'Server returned 401 after successful authentication')),
    ).toBe(true)
    expect(isStalePostAuth401Error(new StreamableHTTPError(401, 'Unauthorized'))).toBe(false)
    expect(isStalePostAuth401Error(new Error('Unauthorized'))).toBe(false)
  })
})

describe('connectToRemoteServer', () => {
  beforeEach(() => {
    mockState.httpTransports.length = 0
    mockState.connectFailuresRemaining = 1
    mockState.connectError = null
    vi.mocked(runMcpOAuthAuth).mockResolvedValue('REDIRECT' as any)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('completes auth on the transport that received the 401 challenge in proxy mode (regression: #270)', async () => {
    const authInitializer = vi.fn().mockResolvedValue({
      waitForAuthCode: async () => 'auth-code-123',
      skipBrowserAuth: false,
      callbackPort: 0,
    })

    await connectToRemoteServer(null, 'https://mcp.example.com/mcp', {} as any, {}, authInitializer, 'http-first')

    const [mainTransport, testTransport] = mockState.httpTransports
    expect(mockState.httpTransports.length).toBeGreaterThanOrEqual(2)
    expect(testTransport.finishAuth).toHaveBeenCalledTimes(1)
    expect(testTransport.finishAuth).toHaveBeenCalledWith('auth-code-123')
    expect(mainTransport.finishAuth).not.toHaveBeenCalled()
  })

  it('completes auth on the main transport in with-client mode', async () => {
    const authInitializer = vi.fn().mockResolvedValue({
      waitForAuthCode: async () => 'auth-code-456',
      skipBrowserAuth: false,
      callbackPort: 0,
    })

    let clientConnectCalls = 0
    const client = {
      connect: async () => {
        if (clientConnectCalls++ === 0) throw new Error('Unauthorized')
      },
    } as any

    await connectToRemoteServer(client, 'https://mcp.example.com/mcp', {} as any, {}, authInitializer, 'http-first')

    const [mainTransport] = mockState.httpTransports
    expect(mainTransport.finishAuth).toHaveBeenCalledTimes(1)
    expect(mainTransport.finishAuth).toHaveBeenCalledWith('auth-code-456')
  })

  it('re-authenticates at connect when server rejects cached OAuth (401 after successful authentication)', async () => {
    mockState.connectFailuresRemaining = 1
    mockState.connectError = new StreamableHTTPError(401, 'Server returned 401 after successful authentication')

    const invalidateCredentials = vi.fn().mockResolvedValue(undefined)
    const authProvider = { invalidateCredentials } as any
    const authInitializer = vi.fn().mockResolvedValue({
      waitForAuthCode: async () => 'fresh-auth-code',
      skipBrowserAuth: false,
      callbackPort: 0,
    })

    await connectToRemoteServer(
      null,
      'https://agent.example.com/mcp-connect/ms1abc',
      authProvider,
      {},
      authInitializer,
      'http-first',
    )

    expect(invalidateCredentials).toHaveBeenCalledWith('tokens')
    expect(authInitializer).toHaveBeenCalledWith(true)
    expect(runMcpOAuthAuth).toHaveBeenCalled()
    const [, testTransport] = mockState.httpTransports
    expect(testTransport.finishAuth).toHaveBeenCalledWith('fresh-auth-code')
  })
})

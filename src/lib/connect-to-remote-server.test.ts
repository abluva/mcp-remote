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
import { StaleClientRegistrationError } from './stale-client-registration-error'

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

  it('primary recovers from a stale client registration: invalidates all once, reconnects (#299)', async () => {
    const invalidateCredentials = vi.fn().mockResolvedValue(undefined)
    const authProvider = { invalidateCredentials } as any
    const authInitializer = vi.fn().mockResolvedValue({
      waitForAuthCode: async () => 'code',
      skipBrowserAuth: false, // this process is PRIMARY / took over
      callbackPort: 0,
    })

    let connectCalls = 0
    const client = {
      connect: async () => {
        if (connectCalls++ === 0) throw new StaleClientRegistrationError()
      },
    } as any

    await connectToRemoteServer(
      client,
      'https://mcp.example.com/mcp',
      authProvider,
      {},
      authInitializer,
      'http-first',
      new Set(),
      'legacy',
    )

    expect(authInitializer).toHaveBeenCalledWith() // no force argument
    expect(invalidateCredentials).toHaveBeenCalledTimes(1)
    expect(invalidateCredentials).toHaveBeenCalledWith('all')
    expect(connectCalls).toBe(2)
  })

  it('secondary does NOT invalidate on a stale client registration, reconnects (#299)', async () => {
    const invalidateCredentials = vi.fn().mockResolvedValue(undefined)
    const authProvider = { invalidateCredentials } as any
    const authInitializer = vi.fn().mockResolvedValue({
      waitForAuthCode: async () => 'code',
      skipBrowserAuth: true, // this process is SECONDARY (primary already recovered)
      callbackPort: 0,
    })

    let connectCalls = 0
    const client = {
      connect: async () => {
        if (connectCalls++ === 0) throw new StaleClientRegistrationError()
      },
    } as any

    await connectToRemoteServer(
      client,
      'https://mcp.example.com/mcp',
      authProvider,
      {},
      authInitializer,
      'http-first',
      new Set(),
      'legacy',
    )

    expect(authInitializer).toHaveBeenCalledWith() // no force argument
    expect(invalidateCredentials).not.toHaveBeenCalled()
    expect(connectCalls).toBe(2)
  })

  it('two instances observe the same stale client: only the primary invalidates (#299)', async () => {
    const runInstance = async (skipBrowserAuth: boolean) => {
      const invalidateCredentials = vi.fn().mockResolvedValue(undefined)
      const authProvider = { invalidateCredentials } as any
      const authInitializer = vi.fn().mockResolvedValue({
        waitForAuthCode: async () => 'code',
        skipBrowserAuth,
        callbackPort: 0,
      })
      let connectCalls = 0
      const client = {
        connect: async () => {
          if (connectCalls++ === 0) throw new StaleClientRegistrationError()
        },
      } as any
      await connectToRemoteServer(
        client,
        'https://mcp.example.com/mcp',
        authProvider,
        {},
        authInitializer,
        'http-first',
        new Set(),
        'legacy',
      )
      return { invalidateCredentials, connectCalls }
    }

    const primary = await runInstance(false)
    const secondary = await runInstance(true)

    expect(primary.invalidateCredentials).toHaveBeenCalledTimes(1)
    expect(primary.invalidateCredentials).toHaveBeenCalledWith('all')
    expect(secondary.invalidateCredentials).not.toHaveBeenCalled()
    // Exactly one of the two instances performed the destructive invalidation.
    const totalInvalidations =
      primary.invalidateCredentials.mock.calls.length + secondary.invalidateCredentials.mock.calls.length
    expect(totalInvalidations).toBe(1)
    // Both instances still recovered (reconnected once each).
    expect(primary.connectCalls).toBe(2)
    expect(secondary.connectCalls).toBe(2)
  })

  it('primary without invalidateCredentials rethrows and does not reconnect with stale state (#299)', async () => {
    const authProvider = {} as any // no invalidateCredentials available
    const authInitializer = vi.fn().mockResolvedValue({
      waitForAuthCode: async () => 'code',
      skipBrowserAuth: false, // PRIMARY
      callbackPort: 0,
    })

    let connectCalls = 0
    const client = {
      connect: async () => {
        connectCalls++
        throw new StaleClientRegistrationError()
      },
    } as any

    await expect(
      connectToRemoteServer(
        client,
        'https://mcp.example.com/mcp',
        authProvider,
        {},
        authInitializer,
        'http-first',
        new Set(),
        'legacy',
      ),
    ).rejects.toBeInstanceOf(StaleClientRegistrationError)

    // Only the initial connect ran; recovery reconnect must NOT happen when the stale
    // registration cannot be cleared.
    expect(connectCalls).toBe(1)
  })

  it('rethrows if the client registration is still stale after one reconnect (no loop) (#299)', async () => {
    const invalidateCredentials = vi.fn().mockResolvedValue(undefined)
    const authProvider = { invalidateCredentials } as any
    const authInitializer = vi.fn().mockResolvedValue({
      waitForAuthCode: async () => 'code',
      skipBrowserAuth: false,
      callbackPort: 0,
    })

    let connectCalls = 0
    const client = {
      connect: async () => {
        connectCalls++
        throw new StaleClientRegistrationError()
      },
    } as any

    await expect(
      connectToRemoteServer(
        client,
        'https://mcp.example.com/mcp',
        authProvider,
        {},
        authInitializer,
        'http-first',
        new Set(),
        'legacy',
      ),
    ).rejects.toBeInstanceOf(StaleClientRegistrationError)

    // Exactly one recovery attempt (invalidate + reconnect); the second stale rethrows before
    // any third connect and without invalidating again.
    expect(invalidateCredentials).toHaveBeenCalledTimes(1)
    expect(connectCalls).toBe(2)
  })

  it('reconnects with the sibling tokens instead of awaiting a code when skipBrowserAuth (regression: #322)', async () => {
    // A secondary instance: another process ran the browser flow and persisted tokens. There is no
    // authorization code of our own to await, so we must reconnect (re-read disk tokens), not hang.
    const waitForAuthCode = vi.fn().mockRejectedValue(new Error('waitForAuthCode must not be awaited for a secondary'))
    const authInitializer = vi.fn().mockResolvedValue({ waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 })
    mockState.connectFailuresRemaining = 1
    mockState.connectError = new Error('Unauthorized')

    const transport = await connectToRemoteServer(
      null,
      'https://mcp.example.com/mcp',
      {} as any,
      {},
      authInitializer,
      'http-first',
      new Set(),
      'legacy',
    )

    expect(transport).toBeDefined()
    // The secondary reconnected and used the sibling's tokens — never awaited a code, never finished auth.
    expect(waitForAuthCode).not.toHaveBeenCalled()
    for (const t of mockState.httpTransports) expect(t.finishAuth).not.toHaveBeenCalled()
  })

  it('gives up after one reconnect when the sibling tokens still fail, without awaiting a code (regression: #322)', async () => {
    // Server keeps rejecting even after reading the sibling's tokens: bounded to a single reconnect,
    // then a clear error — never an unbounded wait on the secondary dummy waitForAuthCode.
    const waitForAuthCode = vi.fn().mockRejectedValue(new Error('waitForAuthCode must not be awaited for a secondary'))
    const authInitializer = vi.fn().mockResolvedValue({ waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 })
    mockState.connectFailuresRemaining = Number.MAX_SAFE_INTEGER
    mockState.connectError = new Error('Unauthorized')

    await expect(
      connectToRemoteServer(null, 'https://mcp.example.com/mcp', {} as any, {}, authInitializer, 'http-first', new Set(), 'legacy'),
    ).rejects.toThrow(/Already attempted reconnection/)

    expect(waitForAuthCode).not.toHaveBeenCalled()
  })
})

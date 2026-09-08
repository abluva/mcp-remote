import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => ({
  httpTransports: [] as Array<{ start: ReturnType<typeof vi.fn>; finishAuth: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  connectFailuresRemaining: 1,
  connectError: null as Error | null,
  // Stateless (2026-07-28) transport mock state — its start() throws while failures remain.
  statelessTransports: [] as Array<{ start: ReturnType<typeof vi.fn>; finishAuth: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  statelessFailuresRemaining: 0,
  statelessError: null as Error | null,
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

vi.mock('./stateless-http-transport', () => {
  class StatelessHTTPTransport {
    start = vi.fn().mockImplementation(async () => {
      if (mockState.statelessFailuresRemaining > 0) {
        mockState.statelessFailuresRemaining--
        throw mockState.statelessError ?? new Error('Unauthorized')
      }
    })
    finishAuth = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    discoverResult = {}
    constructor(
      public url: URL,
      public opts: unknown,
    ) {
      mockState.statelessTransports.push(this)
    }
  }
  return { StatelessHTTPTransport }
})

import { connectToRemoteServer, isStalePostAuth401Error, REASON_AUTH_NEEDED, REASON_TOKEN_HANDOFF, PROTOCOL_2026_07_28 } from './utils'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { auth as runMcpOAuthAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import { StaleClientRegistrationError } from './stale-client-registration-error'
import { SecondaryHandoffExhaustedError } from './secondary-handoff-exhausted-error'

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
    mockState.statelessTransports.length = 0
    mockState.statelessFailuresRemaining = 0
    mockState.statelessError = null
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

  it('gives up as a benign SecondaryHandoffExhaustedError after handoff + one coordinated recovery, without awaiting a code (regression: #322/#352)', async () => {
    // Server keeps rejecting even after reading the sibling's tokens AND after one coordinated
    // recovery: bounded, then a benign typed terminal (not the old generic fatal) — and never an
    // unbounded wait on the secondary dummy waitForAuthCode.
    const waitForAuthCode = vi.fn().mockRejectedValue(new Error('waitForAuthCode must not be awaited for a secondary'))
    const authInitializer = vi.fn().mockResolvedValue({ waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 })
    mockState.connectFailuresRemaining = Number.MAX_SAFE_INTEGER
    mockState.connectError = new Error('Unauthorized')

    await expect(
      connectToRemoteServer(null, 'https://mcp.example.com/mcp', {} as any, {}, authInitializer, 'http-first', new Set(), 'legacy'),
    ).rejects.toBeInstanceOf(SecondaryHandoffExhaustedError)

    // Exactly one coordinated recovery attempt was made (authInitializer(true)); no code awaited.
    expect(authInitializer.mock.calls.filter((c) => c[0] === true)).toHaveLength(1)
    expect(waitForAuthCode).not.toHaveBeenCalled()
  })

  // --- #352: secondary token-handoff retry budget separated from REASON_AUTH_NEEDED ---

  it('handoff keeps its own allowance even when REASON_AUTH_NEEDED was already spent — legacy (#352)', async () => {
    // A prior normal OAuth recovery already consumed REASON_AUTH_NEEDED. The token handoff must
    // still get its own one reconnect (bounded by REASON_TOKEN_HANDOFF) rather than being starved.
    const waitForAuthCode = vi.fn().mockRejectedValue(new Error('waitForAuthCode must not be awaited for a secondary'))
    const authInitializer = vi.fn().mockResolvedValue({ waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 })
    mockState.connectFailuresRemaining = 1 // one 401, then the handoff reconnect succeeds
    mockState.connectError = new Error('Unauthorized')

    const seeded = new Set<string>([REASON_AUTH_NEEDED])
    const transport = await connectToRemoteServer(
      null,
      'https://mcp.example.com/mcp',
      {} as any,
      {},
      authInitializer,
      'http-first',
      seeded,
      'legacy',
    )

    expect(transport).toBeDefined()
    expect(seeded.has(REASON_TOKEN_HANDOFF)).toBe(true)
    expect(waitForAuthCode).not.toHaveBeenCalled()
  })

  it('is strictly bounded: initial 401 + handoff reconnect + one coordinated recovery, then exhausts — legacy (#352)', async () => {
    const waitForAuthCode = vi.fn().mockRejectedValue(new Error('waitForAuthCode must not be awaited for a secondary'))
    const authInitializer = vi.fn().mockResolvedValue({ waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 })

    let connectCalls = 0
    const client = {
      connect: async () => {
        connectCalls++
        throw new Error('Unauthorized')
      },
    } as any

    await expect(
      connectToRemoteServer(client, 'https://mcp.example.com/mcp', {} as any, {}, authInitializer, 'http-first', new Set(), 'legacy'),
    ).rejects.toBeInstanceOf(SecondaryHandoffExhaustedError)

    // initial attempt + Step A handoff reconnect + Step B coordinated-recovery reconnect = 3, then stop.
    expect(connectCalls).toBe(3)
    expect(authInitializer.mock.calls.filter((c) => c[0] === true)).toHaveLength(1)
    expect(waitForAuthCode).not.toHaveBeenCalled()
  })

  it('takes over as primary when the coordinator re-elects it (primary vanished) — legacy (#352)', async () => {
    // Step B's coordinated recovery returns skipBrowserAuth:false: the primary disappeared and this
    // instance was elected primary. It must then run the normal browser-auth flow (awaiting a code)
    // and reconnect — never a duplicate primary, guaranteed by the exclusive port bind (#17).
    const waitForAuthCode = vi.fn().mockResolvedValue('takeover-code')
    const authInitializer = vi.fn().mockImplementation(async (force?: boolean) => {
      if (force) return { waitForAuthCode, skipBrowserAuth: false, callbackPort: 0 } // took over as primary
      return { waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 } // secondary
    })

    let connectCalls = 0
    const client = {
      connect: async () => {
        connectCalls++
        if (connectCalls < 3) throw new Error('Unauthorized')
      },
    } as any

    const transport = await connectToRemoteServer(
      client,
      'https://mcp.example.com/mcp',
      {} as any,
      {},
      authInitializer,
      'http-first',
      new Set(),
      'legacy',
    )

    expect(transport).toBeDefined()
    expect(connectCalls).toBe(3) // initial 401 + handoff reconnect 401 + post-takeover reconnect OK
    expect(authInitializer.mock.calls.filter((c) => c[0] === true)).toHaveLength(1)
    expect(waitForAuthCode).toHaveBeenCalledTimes(1) // ran its own auth exactly once after takeover
  })

  it('handoff keeps its own allowance even when REASON_AUTH_NEEDED was already spent — stateless (#352)', async () => {
    const waitForAuthCode = vi.fn().mockRejectedValue(new Error('waitForAuthCode must not be awaited for a secondary'))
    const authInitializer = vi.fn().mockResolvedValue({ waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 })
    mockState.statelessFailuresRemaining = 1 // one 401, then the handoff reconnect succeeds
    mockState.statelessError = new Error('Unauthorized')

    const seeded = new Set<string>([REASON_AUTH_NEEDED])
    const transport = await connectToRemoteServer(
      null,
      'https://mcp.example.com/mcp',
      { tokens: async () => undefined } as any,
      {},
      authInitializer,
      'http-first',
      seeded,
      PROTOCOL_2026_07_28,
    )

    expect(transport).toBeDefined()
    expect(seeded.has(REASON_TOKEN_HANDOFF)).toBe(true)
    expect(mockState.statelessTransports.length).toBe(2) // initial + one handoff reconnect
    expect(waitForAuthCode).not.toHaveBeenCalled()
  })

  it('is strictly bounded and exhausts to SecondaryHandoffExhaustedError — stateless (#352)', async () => {
    const waitForAuthCode = vi.fn().mockRejectedValue(new Error('waitForAuthCode must not be awaited for a secondary'))
    const authInitializer = vi.fn().mockResolvedValue({ waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 })
    mockState.statelessFailuresRemaining = Number.MAX_SAFE_INTEGER
    mockState.statelessError = new Error('Unauthorized')

    await expect(
      connectToRemoteServer(
        null,
        'https://mcp.example.com/mcp',
        { tokens: async () => undefined } as any,
        {},
        authInitializer,
        'http-first',
        new Set(),
        PROTOCOL_2026_07_28,
      ),
    ).rejects.toBeInstanceOf(SecondaryHandoffExhaustedError)

    // initial + Step A reconnect + Step B recovery reconnect = 3 transports constructed, then stop.
    expect(mockState.statelessTransports.length).toBe(3)
    expect(authInitializer.mock.calls.filter((c) => c[0] === true)).toHaveLength(1)
    expect(waitForAuthCode).not.toHaveBeenCalled()
  })

  it('takes over as primary when the coordinator re-elects it (primary vanished) — stateless (#352)', async () => {
    const waitForAuthCode = vi.fn().mockResolvedValue('takeover-code')
    const authInitializer = vi.fn().mockImplementation(async (force?: boolean) => {
      if (force) return { waitForAuthCode, skipBrowserAuth: false, callbackPort: 0 }
      return { waitForAuthCode, skipBrowserAuth: true, callbackPort: 0 }
    })
    mockState.statelessFailuresRemaining = 2 // initial 401 + handoff reconnect 401, then success
    mockState.statelessError = new Error('Unauthorized')

    const transport = await connectToRemoteServer(
      null,
      'https://mcp.example.com/mcp',
      { tokens: async () => undefined } as any,
      {},
      authInitializer,
      'http-first',
      new Set(),
      PROTOCOL_2026_07_28,
    )

    expect(transport).toBeDefined()
    expect(mockState.statelessTransports.length).toBe(3)
    expect(authInitializer.mock.calls.filter((c) => c[0] === true)).toHaveLength(1)
    expect(waitForAuthCode).toHaveBeenCalledTimes(1)
  })
})

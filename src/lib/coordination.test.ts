import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { EventEmitter } from 'events'
import net from 'net'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { Server } from 'http'
import { coordinateAuth, waitForPrimaryTokens } from './coordination'
import { calculateFallbackPort, findAvailablePort, getServerUrlHash, isCallbackServerListening } from './utils'
import { NodeOAuthClientProvider } from './node-oauth-client-provider'

/**
 * Regression tests for Issue #17 — cross-process OAuth coordination.
 *
 * The fix elects exactly one OAuth "primary" per serverUrlHash using an exclusive bind
 * of the deterministic callback port as the mutex (works on Windows and POSIX). These
 * tests exercise coordinateAuth directly with real ephemeral servers.
 */
describe('coordinateAuth — cross-process OAuth election (Issue #17)', () => {
  const openServers: Server[] = []
  const blockers: net.Server[] = []
  const blockerSockets: net.Socket[] = []
  let tmpDir: string
  let prevConfigDir: string | undefined

  beforeAll(() => {
    // coordinateAuth installs process 'exit'/'SIGINT' listeners per primary election.
    process.setMaxListeners(100)
  })

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    prevConfigDir = process.env.MCP_REMOTE_CONFIG_DIR
    tmpDir = path.join(os.tmpdir(), `mcp17-coord-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    process.env.MCP_REMOTE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    for (const s of openServers.splice(0)) {
      await new Promise<void>((resolve) => {
        try {
          ;(s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
          s.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    // Destroy any sockets the raw blocker accepted so its close() can complete.
    for (const s of blockerSockets.splice(0)) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    for (const b of blockers.splice(0)) {
      await new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, 1000) // never hang the hook
        try {
          b.close(() => {
            clearTimeout(guard)
            resolve()
          })
        } catch {
          clearTimeout(guard)
          resolve()
        }
      })
    }
    if (prevConfigDir === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR
    else process.env.MCP_REMOTE_CONFIG_DIR = prevConfigDir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks()
  })

  const track = (s: Server) => {
    openServers.push(s)
    return s
  }

  it('single instance becomes primary and owns the requested port', async () => {
    const hash = getServerUrlHash('https://single.example.com/mcp')
    const port = await findAvailablePort()

    const res = await coordinateAuth(hash, port, new EventEmitter(), 500)
    track(res.server)

    expect(res.skipBrowserAuth).toBe(false)
    expect(res.callbackPort).toBe(port)
  }, 15000)

  it('two concurrent instances elect exactly one primary; the other waits as secondary (protects the single PKCE verifier writer)', async () => {
    const hash = getServerUrlHash('https://concurrent.example.com/mcp')
    const port = await findAvailablePort()

    // Generous auth timeout: the secondary's wait is now bounded by authTimeoutMs, so give it
    // comfortable margin over the ~400ms we wait before completing the primary's auth.
    const p1 = coordinateAuth(hash, port, new EventEmitter(), 5000)
    const p2 = coordinateAuth(hash, port, new EventEmitter(), 5000)

    // Let both processes run the election, then complete the primary's auth so the
    // secondary unblocks and reads tokens from disk.
    await new Promise((r) => setTimeout(r, 400))
    await fetch(`http://127.0.0.1:${port}/oauth/callback?code=test-code`).catch(() => {})

    const [r1, r2] = await Promise.all([p1, p2])
    track(r1.server)
    track(r2.server)

    const primaries = [r1, r2].filter((r) => !r.skipBrowserAuth)
    const secondaries = [r1, r2].filter((r) => r.skipBrowserAuth)

    // Exactly one primary => exactly one process writes code_verifier.txt (Issue #17 fix).
    expect(primaries).toHaveLength(1)
    expect(secondaries).toHaveLength(1)
    expect(primaries[0].callbackPort).toBe(port)
  }, 20000)

  it('an unrelated process occupying the callback port forces a fallback to another port (still primary)', async () => {
    const hash = getServerUrlHash('https://foreign.example.com/mcp')
    const port = await findAvailablePort()

    // Occupy the canonical port with a raw TCP server that does NOT speak our HTTP callback API.
    const blocker = net.createServer((socket) => blockerSockets.push(socket))
    blockers.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()))

    const res = await coordinateAuth(hash, port, new EventEmitter(), 500)
    track(res.server)

    // Genuine conflict => fall back to a different port but remain primary.
    expect(res.skipBrowserAuth).toBe(false)
    expect(res.callbackPort).not.toBe(port)
  }, 20000)

  it('when the primary exits, another instance can take over as primary on the same port', async () => {
    const hash = getServerUrlHash('https://takeover.example.com/mcp')
    const port = await findAvailablePort()

    // First instance becomes primary. Generous auth timeout so the secondary's bounded wait
    // has comfortable margin over the ~400ms before the primary exits.
    const primary = await coordinateAuth(hash, port, new EventEmitter(), 5000)
    expect(primary.skipBrowserAuth).toBe(false)
    expect(primary.callbackPort).toBe(port)

    // Second instance starts while the primary is alive -> becomes a waiting secondary.
    const takeover = coordinateAuth(hash, port, new EventEmitter(), 5000)

    await new Promise((r) => setTimeout(r, 400))

    // Primary exits (frees the port). Force-close connections so the secondary detects it quickly.
    await new Promise<void>((resolve) => {
      ;(primary.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      primary.server.close(() => resolve())
    })

    const res = await takeover
    track(res.server)

    expect(res.skipBrowserAuth).toBe(false)
    expect(res.callbackPort).toBe(port)
  }, 25000)

  it('an unrelated process on the canonical port does NOT let two concurrent instances both become primary (Risk 2)', async () => {
    const hash = getServerUrlHash('https://risk2.example.com/mcp')
    const canonicalPort = await findAvailablePort()

    // Unrelated process squats on the canonical port (does not speak our callback API).
    const blocker = net.createServer((socket) => blockerSockets.push(socket))
    blockers.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(canonicalPort, '127.0.0.1', () => resolve()))

    // Two mcp-remote instances start concurrently against the same (foreign-occupied) canonical port.
    // Generous auth timeout so the secondary's bounded wait has comfortable margin.
    const p1 = coordinateAuth(hash, canonicalPort, new EventEmitter(), 5000)
    const p2 = coordinateAuth(hash, canonicalPort, new EventEmitter(), 5000)

    // The primary resolves quickly (on a deterministic fallback port); the secondary blocks.
    const first = await Promise.race([p1, p2])
    expect(first.skipBrowserAuth).toBe(false)
    expect(first.callbackPort).not.toBe(canonicalPort)

    // Complete the primary's auth so the secondary unblocks.
    await fetch(`http://127.0.0.1:${first.callbackPort}/oauth/callback?code=test-code`).catch(() => {})

    const [r1, r2] = await Promise.all([p1, p2])
    track(r1.server)
    track(r2.server)

    const primaries = [r1, r2].filter((r) => !r.skipBrowserAuth)
    const secondaries = [r1, r2].filter((r) => r.skipBrowserAuth)

    // The key guarantee: exactly one primary even though the canonical port is foreign-occupied.
    expect(primaries).toHaveLength(1)
    expect(secondaries).toHaveLength(1)
    expect(primaries[0].callbackPort).not.toBe(canonicalPort)
    // And it landed on a deterministic fallback port (not a random drift).
    expect(primaries[0].callbackPort).toBe(calculateFallbackPort(hash, 1))
  }, 25000)

  it('secondary fails with a timeout error (does not hang forever) when the primary stays alive but never completes OAuth (review comment #1)', async () => {
    const hash = getServerUrlHash('https://never-completes.example.com/mcp')
    const port = await findAvailablePort()

    // First instance becomes primary and stays alive, but authentication is never completed
    // (simulating a user who closes the browser or an auth flow that hangs).
    const primaryAuthTimeoutMs = 300
    const primary = await coordinateAuth(hash, port, new EventEmitter(), primaryAuthTimeoutMs)
    track(primary.server)
    expect(primary.skipBrowserAuth).toBe(false)
    expect(primary.callbackPort).toBe(port)

    // Second instance becomes a waiting secondary. Its wait must be bounded by the shared
    // --auth-timeout (authTimeoutMs) rather than looping forever.
    const secondaryAuthTimeoutMs = 1000
    const start = Date.now()

    await expect(coordinateAuth(hash, port, new EventEmitter(), secondaryAuthTimeoutMs)).rejects.toThrow(/timed out/i)

    const elapsed = Date.now() - start
    // It waited roughly the configured timeout (not forever) and did not return early.
    expect(elapsed).toBeGreaterThanOrEqual(secondaryAuthTimeoutMs - 100)
    expect(elapsed).toBeLessThan(secondaryAuthTimeoutMs + 3000)
  }, 15000)

  it('secondary picks up the tokens the primary wrote to disk (token handoff, not just skipBrowserAuth)', async () => {
    const hash = getServerUrlHash('https://handoff.example.com/mcp')
    const port = await findAvailablePort()

    // Generous auth timeout so the secondary's bounded wait has comfortable margin over the
    // token persistence + completion handshake below.
    const p1 = coordinateAuth(hash, port, new EventEmitter(), 5000)
    const p2 = coordinateAuth(hash, port, new EventEmitter(), 5000)

    const first = await Promise.race([p1, p2])
    expect(first.skipBrowserAuth).toBe(false)

    // Simulate the primary completing OAuth: persist tokens to disk (what the SDK does), then
    // signal completion on the callback server so the secondary unblocks.
    const primaryProvider = new NodeOAuthClientProvider({
      serverUrl: 'https://handoff.example.com/mcp',
      callbackPort: first.callbackPort,
      host: 'localhost',
      serverUrlHash: hash,
    })
    await primaryProvider.saveTokens({
      access_token: 'tok-abc',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'ref-xyz',
    })
    await fetch(`http://127.0.0.1:${first.callbackPort}/oauth/callback?code=test-code`).catch(() => {})

    const [r1, r2] = await Promise.all([p1, p2])
    track(r1.server)
    track(r2.server)

    const secondary = [r1, r2].find((r) => r.skipBrowserAuth)
    expect(secondary).toBeDefined()

    // The secondary reuses the tokens the primary wrote to the shared (per-hash) config dir.
    const secondaryProvider = new NodeOAuthClientProvider({
      serverUrl: 'https://handoff.example.com/mcp',
      callbackPort: secondary!.callbackPort,
      host: 'localhost',
      serverUrlHash: hash,
    })
    const tokens = await secondaryProvider.tokens()
    expect(tokens?.access_token).toBe('tok-abc')
    expect(tokens?.refresh_token).toBe('ref-xyz')
  }, 25000)

  it('a secondary waitForAuthCode() rejects instead of hanging forever (#322)', async () => {
    const hash = getServerUrlHash('https://dummy-reject.example.com/mcp')
    const port = await findAvailablePort()

    const primary = await coordinateAuth(hash, port, new EventEmitter(), 5000)
    track(primary.server)
    expect(primary.skipBrowserAuth).toBe(false)

    // A concurrent secondary; complete the primary's callback so it resolves as 'completed'.
    const secondaryPromise = coordinateAuth(hash, port, new EventEmitter(), 5000)
    await fetch(`http://127.0.0.1:${port}/oauth/callback?code=code-for-primary`).catch(() => {})
    const secondary = await secondaryPromise
    track(secondary.server)
    expect(secondary.skipBrowserAuth).toBe(true)

    // The secondary must never hand back a code: waitForAuthCode rejects rather than returning a
    // promise that never settles (which previously blocked until the MCP host timed out). (#322)
    await expect(secondary.waitForAuthCode()).rejects.toThrow(/secondary instance/i)
  }, 15000)

  it('secondary reports the real coordinating (fallback) port, not the canonical or its dummy port (#352 benign-exit)', async () => {
    // The canonical port is squatted by an UNRELATED process, so #17 elects the primary on a
    // deterministic fallback port. The secondary must surface that fallback port as its
    // coordinationPort so the #352 benign-exit check can confirm the live primary on the correct
    // port — never the canonical port (where the unrelated occupant lives) or its own dummy port.
    const hash = getServerUrlHash('https://coord-port.example.com/mcp')
    const canonicalPort = await findAvailablePort()

    const blocker = net.createServer((socket) => blockerSockets.push(socket))
    blockers.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(canonicalPort, '127.0.0.1', () => resolve()))

    const p1 = coordinateAuth(hash, canonicalPort, new EventEmitter(), 5000)
    const p2 = coordinateAuth(hash, canonicalPort, new EventEmitter(), 5000)

    // Primary lands on the deterministic fallback port; complete its callback so the secondary unblocks.
    const first = await Promise.race([p1, p2])
    expect(first.skipBrowserAuth).toBe(false)
    await fetch(`http://127.0.0.1:${first.callbackPort}/oauth/callback?code=test-code`).catch(() => {})

    const [r1, r2] = await Promise.all([p1, p2])
    track(r1.server)
    track(r2.server)

    const primary = [r1, r2].find((r) => !r.skipBrowserAuth)!
    const secondary = [r1, r2].find((r) => r.skipBrowserAuth)!
    const fallbackPort = calculateFallbackPort(hash, 1)

    // Primary is on the fallback port, and reports it as its coordination port.
    expect(primary.callbackPort).toBe(fallbackPort)
    expect(primary.coordinationPort).toBe(fallbackPort)

    // The secondary's coordinationPort points at the primary's real (fallback) port...
    expect(secondary.coordinationPort).toBe(fallbackPort)
    // ...which is neither the canonical port (unrelated occupant) nor its own throwaway dummy port.
    expect(secondary.coordinationPort).not.toBe(canonicalPort)
    expect(secondary.coordinationPort).not.toBe(secondary.callbackPort)

    // Sanity: probing the coordinationPort confirms OUR primary; probing the canonical port (the
    // unrelated raw-TCP occupant) does not — so the benign-exit check keys off the right port.
    expect(await isCallbackServerListening(secondary.coordinationPort)).toBe(true)
    expect(await isCallbackServerListening(canonicalPort)).toBe(false)
  }, 25000)
})

/**
 * Regression tests for Issue #322 — secondary token handoff.
 *
 * `waitForPrimaryTokens` polls the real token store (injected as `authProvider.tokens()` in the
 * proxy) so a secondary proceeds only once the primary has actually persisted its tokens, rather
 * than gambling on a fixed ~1s sleep that could race a slow token exchange.
 */
describe('waitForPrimaryTokens — secondary token handoff (Issue #322)', () => {
  it('Scenario: Token already present → returns immediately', async () => {
    const start = Date.now()
    const result = await waitForPrimaryTokens(async () => true, 30_000, 200)
    const elapsed = Date.now() - start

    expect(result).toBe(true)
    // Short-circuits on the first check without sleeping a poll interval
    expect(elapsed).toBeLessThan(100)
  })

  it('Scenario: Token appears after a short delay → waits only until it appears', async () => {
    const appearAt = Date.now() + 120
    const start = Date.now()
    const result = await waitForPrimaryTokens(async () => Date.now() >= appearAt, 5_000, 50)
    const elapsed = Date.now() - start

    expect(result).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('Scenario: Token appears after more than 1 second → still succeeds (old 1s race fixed)', async () => {
    const appearAt = Date.now() + 1_300
    const start = Date.now()
    const result = await waitForPrimaryTokens(async () => Date.now() >= appearAt, 30_000, 200)
    const elapsed = Date.now() - start

    expect(result).toBe(true)
    // The old fixed 1s handoff would have proceeded here with no token; the poll waits past 1s.
    expect(elapsed).toBeGreaterThan(1_000)
    expect(elapsed).toBeLessThan(5_000)
  }, 10_000)

  it('Scenario: Token never appears → stops after the overall timeout, not forever', async () => {
    const start = Date.now()
    const result = await waitForPrimaryTokens(async () => false, 400, 50)
    const elapsed = Date.now() - start

    expect(result).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(400)
    // Bounded: proves no unbounded wait was introduced
    expect(elapsed).toBeLessThan(2_000)
  })

  it('Scenario: A transient read error is tolerated and polling continues', async () => {
    let calls = 0
    const result = await waitForPrimaryTokens(
      async () => {
        calls++
        if (calls === 1) throw new Error('temporarily unavailable (mid-write)')
        return calls >= 3 // false on 2nd check, true on 3rd
      },
      5_000,
      50,
    )

    expect(result).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('Scenario: Token that appears on the last interval before the deadline is still caught', async () => {
    const appearAt = Date.now() + 260
    const result = await waitForPrimaryTokens(async () => Date.now() >= appearAt, 400, 100)

    expect(result).toBe(true)
  })
})

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { EventEmitter } from 'events'
import net from 'net'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { Server } from 'http'
import { coordinateAuth } from './coordination'
import { calculateFallbackPort, findAvailablePort, getServerUrlHash } from './utils'
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
})

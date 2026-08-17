import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { discoverOAuthServerInfo } from './utils'

/**
 * Risk 1 regression: discovery must flag servers that are reachable without authentication
 * so runProxy can skip eager OAuth coordination (otherwise a secondary instance would block
 * forever waiting for an auth flow that never happens for a no-auth server).
 */
describe('discoverOAuthServerInfo — no-auth signal (Issue #17, Risk 1)', () => {
  const servers: http.Server[] = []

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
    vi.restoreAllMocks()
  })

  const startServer = async (status: number): Promise<{ url: string; server: http.Server }> => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = http.createServer((_req, res) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    return { url: `http://127.0.0.1:${port}/mcp`, server }
  }

  it('sets serverAccessibleWithoutAuth when the server responds 200 without auth', async () => {
    const { url } = await startServer(200)
    const result = await discoverOAuthServerInfo(url)
    expect(result.serverAccessibleWithoutAuth).toBe(true)
  }, 15000)

  it('does NOT set serverAccessibleWithoutAuth when the server requires auth (401)', async () => {
    const { url } = await startServer(401)
    const result = await discoverOAuthServerInfo(url)
    expect(result.serverAccessibleWithoutAuth).toBeFalsy()
  }, 15000)
})

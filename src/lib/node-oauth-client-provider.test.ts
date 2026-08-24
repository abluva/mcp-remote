import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import open from 'open'
import { NodeOAuthClientProvider } from './node-oauth-client-provider'
import * as mcpAuthConfig from './mcp-auth-config'
import type { OAuthProviderOptions } from './types'
import type { AuthorizationServerMetadata } from './authorization-server-metadata'

vi.mock('./mcp-auth-config')
vi.mock('./authorization-server-metadata', () => ({
  fetchAuthorizationServerMetadata: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./utils', () => ({
  getServerUrlHash: () => 'test-hash',
  log: vi.fn(),
  debugLog: vi.fn(),
  DEBUG: false,
  MCP_REMOTE_VERSION: '1.0.0',
}))
vi.mock('open', () => ({ default: vi.fn() }))

describe('NodeOAuthClientProvider - OAuth Scope Handling', () => {
  let provider: NodeOAuthClientProvider
  let mockReadJsonFile: any
  let mockWriteJsonFile: any
  let mockDeleteConfigFile: any

  const defaultOptions: OAuthProviderOptions = {
    serverUrl: 'https://example.com',
    callbackPort: 8080,
    host: 'localhost',
    serverUrlHash: 'test-hash',
  }

  beforeEach(() => {
    mockReadJsonFile = vi.mocked(mcpAuthConfig.readJsonFile)
    mockWriteJsonFile = vi.mocked(mcpAuthConfig.writeJsonFile)
    mockDeleteConfigFile = vi.mocked(mcpAuthConfig.deleteConfigFile)

    mockReadJsonFile.mockResolvedValue(undefined)
    mockWriteJsonFile.mockResolvedValue(undefined)
    mockDeleteConfigFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('scope priority', () => {
    it('should prioritize custom scope from staticOAuthClientMetadata', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom read write',
        } as any,
      })

      const metadata = provider.clientMetadata
      expect(metadata.scope).toBe('custom read write')
    })

    it('should use scope from registration response', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      const clientInfo = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
        scope: 'openid email profile read:user',
      }

      await provider.saveClientInformation(clientInfo)
      await provider.clientInformation()

      const metadata = provider.clientMetadata
      expect(metadata.scope).toBe('openid email profile read:user')
    })

    it('should fallback to default scopes when none provided', () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      const metadata = provider.clientMetadata
      expect(metadata.scope).toBe('openid email profile')
    })
  })

  describe('authorization URL', () => {
    it('should include scope parameter in authorization URL', async () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'github read:user',
        } as any,
      })

      const authUrl = new URL('https://auth.example.com/authorize')
      await provider.redirectToAuthorization(authUrl)

      expect(authUrl.searchParams.get('scope')).toBe('github read:user')
    })

    it('should include default scope in authorization URL when none specified', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      const authUrl = new URL('https://auth.example.com/authorize')
      await provider.redirectToAuthorization(authUrl)

      expect(authUrl.searchParams.get('scope')).toBe('openid email profile')
    })
  })

  describe('backward compatibility', () => {
    it('should preserve existing custom scope behavior', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'user:email repo',
          client_name: 'My Custom Client',
        } as any,
      })

      const metadata = provider.clientMetadata

      expect(metadata).toMatchObject({
        scope: 'user:email repo',
        client_name: 'My Custom Client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        software_id: '2e6dc280-f3c3-4e01-99a7-8181dbd1d23d',
        software_version: '1.0.0',
      })
    })
  })

  describe('credential invalidation', () => {
    it('should reset to default scopes after client invalidation', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      const clientInfo = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
        scope: 'extracted custom scopes',
      }

      mockReadJsonFile.mockResolvedValueOnce(clientInfo)
      await provider.clientInformation()
      expect(provider.clientMetadata.scope).toBe('extracted custom scopes')

      await provider.invalidateCredentials('client')

      expect(provider.clientMetadata.scope).toBe('openid email profile')
      expect(mockDeleteConfigFile).toHaveBeenCalledWith('test-hash', 'client_info.json')
    })

    it('should not delete client info when invalidating only tokens', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      await provider.invalidateCredentials('tokens')

      expect(mockDeleteConfigFile).toHaveBeenCalledWith('test-hash', 'tokens.json')
      expect(mockDeleteConfigFile).not.toHaveBeenCalledWith('test-hash', 'client_info.json')
    })
  })

  describe('scopes_supported parsing', () => {
    it('should use custom scopes without filtering', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: ['openid', 'email', 'profile'],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'openid email profile custom:read custom:write',
        } as any,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      // Should use all requested scopes without filtering
      expect(clientMetadata.scope).toBe('openid email profile custom:read custom:write')
    })

    it('should use requested scopes regardless of scopes_supported', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: ['some', 'other', 'scopes'],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom:read custom:write',
        } as any,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      // Should use requested scopes even if not in scopes_supported
      expect(clientMetadata.scope).toBe('custom:read custom:write')
    })

    it('should use scopes when scopes_supported is missing', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        // No scopes_supported
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom:read custom:write special:scope',
        } as any,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      expect(clientMetadata.scope).toBe('custom:read custom:write special:scope')
    })

    it('should use scopes when scopes_supported is empty', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: [],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom:read custom:write',
        } as any,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      expect(clientMetadata.scope).toBe('custom:read custom:write')
    })

    it('should use scopes when no metadata is provided', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom:read custom:write',
        } as any,
      })

      const clientMetadata = provider.clientMetadata
      expect(clientMetadata.scope).toBe('custom:read custom:write')
    })

    it('should use scopes from client registration response', async () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: ['openid', 'email'],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        authorizationServerMetadata: metadata,
      })

      const clientInfo = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
        scope: 'openid email profile custom:read',
      }

      await provider.saveClientInformation(clientInfo)
      await provider.clientInformation()

      const clientMetadata = provider.clientMetadata
      // Should use all scopes from registration response
      expect(clientMetadata.scope).toBe('openid email profile custom:read')
    })

    it('should use scopes_supported when no user or client scopes provided', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: ['openid', 'email'],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      // Should use scopes_supported when nothing else is provided
      expect(clientMetadata.scope).toBe('openid email')
    })

    it('should treat empty scope string as no scope and use default', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: '',
        } as any,
      })

      const clientMetadata = provider.clientMetadata
      // Empty scope should fallback to default
      expect(clientMetadata.scope).toBe('openid email profile')
    })
  })
})

describe('NodeOAuthClientProvider - stale dynamic client registration preflight (#299)', () => {
  let provider: NodeOAuthClientProvider
  let mockReadJsonFile: any
  let mockWriteJsonFile: any
  let mockDeleteConfigFile: any

  const defaultOptions: OAuthProviderOptions = {
    serverUrl: 'https://example.com',
    callbackPort: 8080,
    host: 'localhost',
    serverUrlHash: 'test-hash',
  }

  // Exact upstream stale-registration response shape: a DCR registration_endpoint plus an
  // error_description stating the client is not registered.
  const staleBody = {
    registration_endpoint: 'https://auth.example.com/register',
    error: 'invalid_request',
    error_description: "Client ID 'fresh-client' is not registered with this server",
  }

  const authUrl = () => new URL('https://auth.example.com/authorize?client_id=fresh-client')
  const AUTH_ORIGIN = 'https://auth.example.com'

  // Minimal fetch Response stand-ins (only the fields the preflight reads).
  const redirectResponse = (location: string, status = 302) => ({
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) },
  })
  const jsonResponse = (status: number, value: unknown, contentType = 'application/json; charset=utf-8') => ({
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => value,
  })
  const htmlResponse = (status = 200, body = '<html>consent</html>') => ({
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    json: async () => {
      throw new Error('not json')
    },
    text: async () => body,
  })

  // The provider is detection-only: it must never delete shared OAuth state. Ownership-gated
  // invalidation happens in connectToRemoteServer (primary only), covered by the connect tests.
  const expectNoInvalidation = () => {
    expect(mockDeleteConfigFile).not.toHaveBeenCalled()
  }

  const asCachedDynamic = async (p: NodeOAuthClientProvider) => {
    mockReadJsonFile.mockResolvedValueOnce({
      client_id: 'cached-client',
      redirect_uris: ['http://localhost:8080/oauth/callback'],
    })
    await p.clientInformation() // source = 'cached-dynamic'
  }

  beforeEach(() => {
    mockReadJsonFile = vi.mocked(mcpAuthConfig.readJsonFile)
    mockWriteJsonFile = vi.mocked(mcpAuthConfig.writeJsonFile)
    mockDeleteConfigFile = vi.mocked(mcpAuthConfig.deleteConfigFile)

    mockReadJsonFile.mockResolvedValue(undefined)
    mockWriteJsonFile.mockResolvedValue(undefined)
    mockDeleteConfigFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('cached dynamic client: stale 400 JSON throws, does NOT delete credentials, browser not opened', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    mockReadJsonFile.mockResolvedValueOnce({
      client_id: 'cached-client',
      redirect_uris: ['http://localhost:8080/oauth/callback'],
    })
    await provider.clientInformation() // source = 'cached-dynamic'

    const mockFetch = vi.fn().mockResolvedValue({ status: 400, json: async () => staleBody })
    vi.stubGlobal('fetch', mockFetch)

    await expect(provider.redirectToAuthorization(authUrl())).rejects.toMatchObject({
      name: 'StaleClientRegistrationError',
      message: 'Cached OAuth client registration is no longer valid',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    )
    expectNoInvalidation()
    expect(open).not.toHaveBeenCalled()
  })

  it('fresh dynamic client: stale response throws, does NOT delete credentials, browser not opened', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await provider.saveClientInformation({
      client_id: 'fresh-client',
      redirect_uris: ['http://localhost:8080/oauth/callback'],
    }) // source = 'fresh-dynamic'

    const mockFetch = vi.fn().mockResolvedValue({ status: 400, json: async () => staleBody })
    vi.stubGlobal('fetch', mockFetch)

    await expect(provider.redirectToAuthorization(authUrl())).rejects.toMatchObject({
      name: 'StaleClientRegistrationError',
    })

    expectNoInvalidation()
    expect(open).not.toHaveBeenCalled()
  })

  it('stale 302 -> same-origin consent -> 400 JSON string "Invalid client_id": throws, no deletion, no browser', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${AUTH_ORIGIN}/consent`))
      .mockResolvedValueOnce(jsonResponse(400, 'Invalid client_id'))
    vi.stubGlobal('fetch', mockFetch)

    await expect(provider.redirectToAuthorization(authUrl())).rejects.toMatchObject({
      name: 'StaleClientRegistrationError',
      message: 'Cached OAuth client registration is no longer valid',
    })

    // One authorize probe + one bounded same-origin consent GET.
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      `${AUTH_ORIGIN}/consent`,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }),
    )
    expectNoInvalidation()
    expect(open).not.toHaveBeenCalled()
  })

  it('valid 302 -> same-origin consent -> 200 HTML: no invalidation, browser opens', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${AUTH_ORIGIN}/consent`))
      .mockResolvedValueOnce(htmlResponse(200))
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('cross-origin consent Location is NOT probed: no throw, browser opens', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const mockFetch = vi.fn().mockResolvedValueOnce(redirectResponse('https://evil.example.com/consent'))
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    // Only the authorize probe runs; the cross-origin consent URL is never fetched.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('consent probe network failure: no throw, browser opens', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${AUTH_ORIGIN}/consent`))
      .mockRejectedValueOnce(new Error('network down'))
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('consent probe timeout: no throw, browser opens', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${AUTH_ORIGIN}/consent`))
      .mockRejectedValueOnce(timeoutError)
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('consent 400 JSON string with a different message is NOT stale', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${AUTH_ORIGIN}/consent`))
      .mockResolvedValueOnce(jsonResponse(400, 'You are not allowed'))
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('consent 400 JSON object (not a string) is NOT stale', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${AUTH_ORIGIN}/consent`))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'Invalid client_id' }))
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('consent 400 generic OAuth JSON error is NOT stale', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${AUTH_ORIGIN}/consent`))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_request', error_description: 'bad request' }))
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('consent 400 text/html containing the phrase is NOT stale (must be application/json)', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    await asCachedDynamic(provider)

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`${AUTH_ORIGIN}/consent`))
      .mockResolvedValueOnce(htmlResponse(400, 'Invalid client_id'))
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('static client: no preflight, browser opens normally', async () => {
    provider = new NodeOAuthClientProvider({
      ...defaultOptions,
      staticOAuthClientInfo: {
        client_id: 'static-client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
      } as any,
    })
    await provider.clientInformation() // source = 'static'

    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expect(mockFetch).not.toHaveBeenCalled()
    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('redirect_uri-not-registered 400 is NOT classified as stale', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    mockReadJsonFile.mockResolvedValueOnce({
      client_id: 'cached-client',
      redirect_uris: ['http://localhost:8080/oauth/callback'],
    })
    await provider.clientInformation()

    const mockFetch = vi.fn().mockResolvedValue({
      status: 400,
      json: async () => ({
        registration_endpoint: 'https://auth.example.com/register',
        error: 'invalid_request',
        error_description: 'The redirect_uri is not registered for this client',
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('invalid_scope / generic 400 is NOT classified as stale', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    mockReadJsonFile.mockResolvedValueOnce({
      client_id: 'cached-client',
      redirect_uris: ['http://localhost:8080/oauth/callback'],
    })
    await provider.clientInformation()

    const mockFetch = vi.fn().mockResolvedValue({
      status: 400,
      json: async () => ({
        registration_endpoint: 'https://auth.example.com/register',
        error: 'invalid_scope',
        error_description: 'The requested scope is invalid or unknown',
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('network error during preflight: browser still opens', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    mockReadJsonFile.mockResolvedValueOnce({
      client_id: 'cached-client',
      redirect_uris: ['http://localhost:8080/oauth/callback'],
    })
    await provider.clientInformation()

    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })

  it('preflight timeout: browser still opens', async () => {
    provider = new NodeOAuthClientProvider(defaultOptions)
    mockReadJsonFile.mockResolvedValueOnce({
      client_id: 'cached-client',
      redirect_uris: ['http://localhost:8080/oauth/callback'],
    })
    await provider.clientInformation()

    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const mockFetch = vi.fn().mockRejectedValue(timeoutError)
    vi.stubGlobal('fetch', mockFetch)

    await provider.redirectToAuthorization(authUrl())

    expectNoInvalidation()
    expect(open).toHaveBeenCalledOnce()
  })
})

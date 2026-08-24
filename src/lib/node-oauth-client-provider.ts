import open from 'open'
import { z } from 'zod'
import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  OAuthClientInformationFull,
  OAuthClientInformationFullSchema,
  OAuthTokens,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthProviderOptions, StaticOAuthClientMetadata } from './types'
import { readJsonFile, writeJsonFile, readTextFile, writeTextFile, deleteConfigFile } from './mcp-auth-config'
import { StaticOAuthClientInformationFull } from './types'
import { log, debugLog, MCP_REMOTE_VERSION } from './utils'
import { sanitizeUrl } from 'strict-url-sanitise'
import { randomUUID } from 'node:crypto'
import { fetchAuthorizationServerMetadata, type AuthorizationServerMetadata } from './authorization-server-metadata'
import type { ProtectedResourceMetadata } from './protected-resource-metadata'
import { StaleClientRegistrationError } from './stale-client-registration-error'

const OAuthTokensWithExpiresAtSchema = OAuthTokensSchema.extend({
  expires_at: z.coerce.number().optional(),
})
type OAuthTokensWithExpiresAt = z.infer<typeof OAuthTokensWithExpiresAtSchema>

type ClientRegistrationSource = 'cached-dynamic' | 'fresh-dynamic' | 'static' | undefined

function isStaleClientRegistrationResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') {
    return false
  }

  const { registration_endpoint: registrationEndpoint, error_description: errorDescription } = response as Record<string, unknown>
  return (
    typeof registrationEndpoint === 'string' &&
    typeof errorDescription === 'string' &&
    /\bclient(?:\s+id)?\b\s+(?:['"][^'"]+['"]\s+)?is\s+not[\s-]+registered\b/i.test(errorDescription)
  )
}

/**
 * Narrow matcher for the consent-redirect stale-client shape (Path 2). Some authorization servers
 * (e.g. Stack Overflow) do not surface an invalid/stale client at /authorize; instead /authorize
 * returns a 30x to a same-origin consent URL, and fetching that consent URL directly returns
 * 400/401 application/json whose body is exactly the JSON string "Invalid client_id". This matches
 * ONLY that precise scalar-string shape — not JSON objects, arrays, or other messages.
 */
function isStaleClientConsentBody(parsed: unknown): boolean {
  return typeof parsed === 'string' && parsed.trim().toLowerCase() === 'invalid client_id'
}

/**
 * Implements the OAuthClientProvider interface for Node.js environments.
 * Handles OAuth flow and token storage for MCP clients.
 */
export class NodeOAuthClientProvider implements OAuthClientProvider {
  private serverUrlHash: string
  private callbackPath: string
  private clientName: string
  private clientUri: string
  private softwareId: string
  private softwareVersion: string
  private staticOAuthClientMetadata: StaticOAuthClientMetadata
  private staticOAuthClientInfo: StaticOAuthClientInformationFull
  private authorizeResource: string | undefined
  private _state: string
  private _clientInfo: OAuthClientInformationFull | undefined
  private clientRegistrationSource: ClientRegistrationSource
  private authorizationServerMetadata: AuthorizationServerMetadata | undefined
  private protectedResourceMetadata: ProtectedResourceMetadata | undefined
  private wwwAuthenticateScope: string | undefined
  private events?: import('events').EventEmitter

  /**
   * Creates a new NodeOAuthClientProvider
   * @param options Configuration options for the provider
   */
  constructor(readonly options: OAuthProviderOptions) {
    this.serverUrlHash = options.serverUrlHash
    this.callbackPath = options.callbackPath || '/oauth/callback'
    this.clientName = options.clientName || 'MCP CLI Client'
    this.clientUri = options.clientUri || 'https://github.com/modelcontextprotocol/mcp-cli'
    this.softwareId = options.softwareId || '2e6dc280-f3c3-4e01-99a7-8181dbd1d23d'
    this.softwareVersion = options.softwareVersion || MCP_REMOTE_VERSION
    this.staticOAuthClientMetadata = options.staticOAuthClientMetadata
    this.staticOAuthClientInfo = options.staticOAuthClientInfo
    this.authorizeResource = options.authorizeResource
    this._state = randomUUID()
    this._clientInfo = undefined
    this.clientRegistrationSource = undefined
    this.authorizationServerMetadata = options.authorizationServerMetadata
    this.protectedResourceMetadata = options.protectedResourceMetadata
    this.wwwAuthenticateScope = options.wwwAuthenticateScope
    this.events = options.events
  }

  get redirectUrl(): string {
    return `http://${this.options.host}:${this.options.callbackPort}${this.callbackPath}`
  }

  setCallbackPort(port: number): void {
    if (this.options.callbackPort !== port) {
      debugLog('Updating OAuth callback port', { from: this.options.callbackPort, to: port })
      this.options.callbackPort = port
    }
  }

  get clientMetadata() {
    const effectiveScope = this.getEffectiveScope()
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.clientName,
      client_uri: this.clientUri,
      software_id: this.softwareId,
      software_version: this.softwareVersion,
      ...this.staticOAuthClientMetadata,
      scope: effectiveScope,
    }
  }

  state(): string {
    return this._state
  }

  /**
   * Gets the authorization server metadata, fetching it if not already available
   * @returns The authorization server metadata, or undefined if unavailable
   */
  async getAuthorizationServerMetadata(): Promise<AuthorizationServerMetadata | undefined> {
    // Already have metadata? Return it
    debugLog(`authorizationServerMetadata: ${JSON.stringify(this.authorizationServerMetadata)}`)
    if (this.authorizationServerMetadata) {
      return this.authorizationServerMetadata
    }

    // Fetch metadata and cache in memory for this session
    try {
      this.authorizationServerMetadata = await fetchAuthorizationServerMetadata(this.options.serverUrl)
      if (this.authorizationServerMetadata?.scopes_supported) {
        debugLog('Authorization server supports scopes', {
          scopes_supported: this.authorizationServerMetadata.scopes_supported,
        })
      }
      return this.authorizationServerMetadata
    } catch (error) {
      debugLog('Failed to fetch authorization server metadata', error)
      return undefined
    }
  }

  private getEffectiveScope(): string {
    // Priority 1: User-provided scope from staticOAuthClientMetadata (highest priority)
    if (this.staticOAuthClientMetadata?.scope && this.staticOAuthClientMetadata.scope.trim().length > 0) {
      debugLog('Using scope from staticOAuthClientMetadata', { scope: this.staticOAuthClientMetadata.scope })
      return this.staticOAuthClientMetadata.scope
    }

    // Priority 2: Scope from WWW-Authenticate header (per MCP spec)
    if (this.wwwAuthenticateScope && this.wwwAuthenticateScope.trim().length > 0) {
      debugLog('Using scope from WWW-Authenticate header', { scope: this.wwwAuthenticateScope })
      return this.wwwAuthenticateScope
    }

    // Priority 3: Scopes from Protected Resource Metadata (RFC 9728)
    if (this.protectedResourceMetadata?.scopes_supported?.length) {
      const scope = this.protectedResourceMetadata.scopes_supported.join(' ')
      debugLog('Using scopes from Protected Resource Metadata', {
        scopes_supported: this.protectedResourceMetadata.scopes_supported,
        scope,
      })
      return scope
    }

    // Priority 4: Scope from client registration response
    if (this._clientInfo?.scope && this._clientInfo.scope.trim().length > 0) {
      debugLog('Using scope from client registration response', { scope: this._clientInfo.scope })
      return this._clientInfo.scope
    }

    // Priority 5: Use authorization server's supported scopes if available
    if (this.authorizationServerMetadata?.scopes_supported?.length) {
      const scope = this.authorizationServerMetadata.scopes_supported.join(' ')
      debugLog('Using scopes from Authorization Server Metadata', {
        scopes_supported: this.authorizationServerMetadata.scopes_supported,
        scope,
      })
      return scope
    }

    // Priority 6: Fallback to hardcoded default
    debugLog('Using fallback default scope')
    return 'openid email profile'
  }

  /**
   * Gets the client information if it exists
   * @returns The client information or undefined
   */
  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    debugLog('Reading client info')
    if (this.staticOAuthClientInfo) {
      debugLog('Returning static client info')
      this._clientInfo = this.staticOAuthClientInfo
      this.clientRegistrationSource = 'static'
      return this.staticOAuthClientInfo
    }
    const clientInfo = await readJsonFile<OAuthClientInformationFull>(
      this.serverUrlHash,
      'client_info.json',
      OAuthClientInformationFullSchema,
    )

    if (clientInfo) {
      this._clientInfo = clientInfo
      if (this.clientRegistrationSource !== 'fresh-dynamic') {
        this.clientRegistrationSource = 'cached-dynamic'
      }
    }

    debugLog('Client info result:', clientInfo ? 'Found' : 'Not found')
    return clientInfo
  }

  /**
   * Saves client information
   * @param clientInformation The client information to save
   */
  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    debugLog('Saving client info', { client_id: clientInformation.client_id })
    this._clientInfo = clientInformation
    this.clientRegistrationSource = 'fresh-dynamic'
    await writeJsonFile(this.serverUrlHash, 'client_info.json', clientInformation)
  }

  /**
   * Gets the OAuth tokens if they exist
   * @returns The OAuth tokens or undefined
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    debugLog('Reading OAuth tokens')
    debugLog('Token request stack trace:', new Error().stack)

    const tokens = await readJsonFile<OAuthTokensWithExpiresAt>(
      this.serverUrlHash,
      'tokens.json',
      OAuthTokensWithExpiresAtSchema,
    )

    if (tokens) {
      const timeLeft = tokens.expires_in || 0

      // Alert if expires_in is invalid
      if (typeof tokens.expires_in !== 'number' || tokens.expires_in < 0) {
        debugLog('⚠️ WARNING: Invalid expires_in detected while reading tokens ⚠️', {
          expiresIn: tokens.expires_in,
          tokenObject: JSON.stringify(tokens),
          stack: new Error('Invalid expires_in value').stack,
        })
      }

      const isExpired = tokens.expires_at ? Date.now() >= tokens.expires_at - 60_000 : false

      debugLog('Token result:', {
        found: true,
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        expiresIn: `${timeLeft} seconds`,
        expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : 'unknown',
        isExpired,
      })

      if (isExpired && tokens.refresh_token) {
        return { ...tokens, access_token: '' }
      }
    } else {
      debugLog('Token result: Not found')
    }

    return tokens
  }

  /**
   * Saves OAuth tokens
   * @param tokens The tokens to save
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const timeLeft = tokens.expires_in || 0

    // Alert if expires_in is invalid
    if (typeof tokens.expires_in !== 'number' || tokens.expires_in < 0) {
      debugLog('⚠️ WARNING: Invalid expires_in detected in tokens ⚠️', {
        expiresIn: tokens.expires_in,
        tokenObject: JSON.stringify(tokens),
        stack: new Error('Invalid expires_in value').stack,
      })
    }

    debugLog('Saving tokens', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: `${timeLeft} seconds`,
      expiresInValue: tokens.expires_in,
    })

    const tokensToSave: OAuthTokensWithExpiresAt = {
      ...tokens,
      expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    }

    await writeJsonFile(this.serverUrlHash, 'tokens.json', tokensToSave)
  }

  /**
   * Redirects the user to the authorization URL
   * @param authorizationUrl The URL to redirect to
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Reset the auth code to null when starting a new authorization flow
    if (this.events) {
      debugLog('Emitting reset-auth-code event')
      this.events.emit('reset-auth-code')
    }

    // Optionally fetch metadata for debugging/informational purposes (non-blocking)
    this.getAuthorizationServerMetadata().catch(() => {
      // Ignore errors, metadata is optional
    })

    if (this.authorizeResource) {
      authorizationUrl.searchParams.set('resource', this.authorizeResource)
    }

    const effectiveScope = this.getEffectiveScope()
    authorizationUrl.searchParams.set('scope', effectiveScope)
    debugLog('Added scope parameter to authorization URL', { scopes: effectiveScope })

    log(`\nPlease authorize this client by visiting:\n${authorizationUrl.toString()}\n`)

    debugLog('Redirecting to authorization URL', authorizationUrl.toString())

    await this.preflightDynamicClientRegistration(authorizationUrl)

    try {
      await open(sanitizeUrl(authorizationUrl.toString()))
      log('Browser opened automatically.')
    } catch (error) {
      log('Could not open browser automatically. Please copy and paste the URL above into your browser.')
      debugLog('Failed to open browser', error)
    }
  }

  /**
   * Preflights the authorization URL for dynamically-registered clients to detect a cached
   * (or freshly-registered) client_id that the authorization server no longer accepts.
   *
   * Two server shapes are handled, both DETECTION-ONLY (this never invalidates credentials —
   * that is gated on #17 ownership in connectToRemoteServer):
   *   1. /authorize returns 400/401 application/json describing an unregistered client
   *      (matched by isStaleClientRegistrationResponse).
   *   2. /authorize returns a 30x to a SAME-ORIGIN consent URL that only reveals the error when
   *      fetched directly. Observed with Stack Overflow: GET consent -> 400 application/json whose
   *      body is exactly the JSON string "Invalid client_id" (matched by
   *      probeConsentRedirectForStaleClient).
   *
   * Any other outcome (non-dynamic client, network failure, timeout, cross-origin redirect,
   * non-400/401 status, non-JSON body, or non-matching body) returns normally so the browser
   * flow proceeds unchanged.
   *
   * Intentionally avoids logging the authorization URL, client_id, state, PKCE
   * challenge/verifier, response body, or any tokens/secrets.
   */
  private async preflightDynamicClientRegistration(authorizationUrl: URL): Promise<void> {
    if (this.clientRegistrationSource !== 'cached-dynamic' && this.clientRegistrationSource !== 'fresh-dynamic') {
      return
    }

    let response: Response
    try {
      response = await fetch(authorizationUrl.toString(), {
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      debugLog('Authorization preflight failed; continuing to browser authorization')
      return
    }

    // Path 1: authorization server returns the error directly at /authorize as 400/401 JSON.
    if (response.status === 400 || response.status === 401) {
      let errorResponse: unknown
      try {
        errorResponse = await response.json()
      } catch {
        debugLog('Authorization preflight returned invalid JSON; continuing to browser authorization')
        return
      }
      if (isStaleClientRegistrationResponse(errorResponse)) {
        debugLog('Authorization preflight detected stale client registration (authorize JSON)')
        throw new StaleClientRegistrationError()
      }
      return
    }

    // Path 2: authorization server redirects (30x) to a same-origin consent URL that only reveals
    // the invalid-client error when that consent URL is fetched directly.
    if (response.status >= 300 && response.status < 400) {
      await this.probeConsentRedirectForStaleClient(response, authorizationUrl)
    }
  }

  /**
   * Makes at most one bounded GET to the same-origin consent Location returned by a 30x
   * /authorize response, and throws StaleClientRegistrationError only when that consent response
   * is 400/401 application/json whose parsed body is exactly the JSON string "Invalid client_id".
   *
   * Detection-only; never invalidates credentials. Cross-origin redirects, non-400/401 statuses,
   * non-JSON content types, non-string JSON, and non-matching strings all return normally so the
   * browser flow is unchanged. Never logs the URL, query values, or body contents.
   */
  private async probeConsentRedirectForStaleClient(redirectResponse: Response, authorizationUrl: URL): Promise<void> {
    const location = redirectResponse.headers.get('location')
    if (!location) {
      return
    }

    let consentUrl: URL
    try {
      consentUrl = new URL(location, authorizationUrl)
    } catch {
      return
    }

    // Only probe a redirect that stays on the authorization server's own origin.
    if (consentUrl.origin !== authorizationUrl.origin) {
      debugLog('Authorization preflight redirect is cross-origin; not probing consent URL')
      return
    }

    let consentResponse: Response
    try {
      consentResponse = await fetch(consentUrl.toString(), {
        redirect: 'manual',
        headers: { Accept: 'text/html,application/json' },
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      debugLog('Consent preflight probe failed; continuing to browser authorization')
      return
    }

    if (consentResponse.status !== 400 && consentResponse.status !== 401) {
      return
    }

    if (!/application\/json/i.test(consentResponse.headers.get('content-type') ?? '')) {
      return
    }

    let parsed: unknown
    try {
      parsed = await consentResponse.json()
    } catch {
      debugLog('Consent preflight returned invalid JSON; continuing to browser authorization')
      return
    }

    if (!isStaleClientConsentBody(parsed)) {
      return
    }

    debugLog('Authorization preflight detected stale client registration (consent JSON)')
    throw new StaleClientRegistrationError()
  }

  /**
   * Saves the PKCE code verifier
   * @param codeVerifier The code verifier to save
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    debugLog('Saving code verifier')
    await writeTextFile(this.serverUrlHash, 'code_verifier.txt', codeVerifier)
  }

  /**
   * Gets the PKCE code verifier
   * @returns The code verifier
   */
  async codeVerifier(): Promise<string> {
    debugLog('Reading code verifier')
    const verifier = await readTextFile(this.serverUrlHash, 'code_verifier.txt', 'No code verifier saved for session')
    debugLog('Code verifier found:', !!verifier)
    return verifier
  }

  /**
   * Invalidates the specified credentials
   * @param scope The scope of credentials to invalidate
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    debugLog(`Invalidating credentials: ${scope}`)

    switch (scope) {
      case 'all':
        await Promise.all([
          deleteConfigFile(this.serverUrlHash, 'client_info.json'),
          deleteConfigFile(this.serverUrlHash, 'tokens.json'),
          deleteConfigFile(this.serverUrlHash, 'code_verifier.txt'),
        ])
        this._clientInfo = undefined
        this.clientRegistrationSource = undefined
        debugLog('All credentials invalidated')
        break

      case 'client':
        await deleteConfigFile(this.serverUrlHash, 'client_info.json')
        this._clientInfo = undefined
        this.clientRegistrationSource = undefined
        debugLog('Client information invalidated')
        break

      case 'tokens':
        await deleteConfigFile(this.serverUrlHash, 'tokens.json')
        debugLog('OAuth tokens invalidated')
        break

      case 'verifier':
        await deleteConfigFile(this.serverUrlHash, 'code_verifier.txt')
        debugLog('Code verifier invalidated')
        break

      default:
        throw new Error(`Unknown credential scope: ${scope}`)
    }
  }
}

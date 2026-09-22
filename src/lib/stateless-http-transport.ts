/**
 * POST-only HTTP transport for MCP 2026-07-28 stateless servers.
 *
 * Performs server/discover on start, injects `_meta` on each request, and never opens SSE.
 */
import { auth as runMcpOAuthAuth, OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { fetch, RequestInit } from 'undici'
// Type-only: the global `Headers` (undici's implementation at runtime in Node) has no `entries()`
// under `lib: ["ES2022", "DOM"]`, which omits DOM.Iterable. Used purely to type the narrowed value.
import type { Headers as UndiciHeaders } from 'undici'
import { ClientMetaContext, DiscoverResult, injectRequestMeta, PROTOCOL_2026_07_28 } from './stateless-protocol.js'

export type StatelessHTTPTransportOptions = {
  authProvider?: OAuthClientProvider
  requestInit?: RequestInit
  protocolVersion?: string
  clientInfo?: { name: string; version: string }
  clientCapabilities?: Record<string, unknown>
}

/**
 * POST-only Streamable HTTP transport for MCP 2026-07-28 (stateless).
 * Does not open a persistent SSE GET stream.
 */
export class StatelessHTTPTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private _url: URL
  private _authProvider?: OAuthClientProvider
  private _requestInit?: RequestInit
  private _metaContext: ClientMetaContext
  private _discoverResult?: DiscoverResult
  private _closed = false
  private _resourceMetadataUrl?: URL
  private _scope?: string

  constructor(url: URL, opts: StatelessHTTPTransportOptions = {}) {
    this._url = url
    this._authProvider = opts.authProvider
    this._requestInit = opts.requestInit
    this._metaContext = {
      protocolVersion: opts.protocolVersion ?? PROTOCOL_2026_07_28,
      clientInfo: opts.clientInfo ?? { name: 'mcp-remote', version: '0.0.0' },
      clientCapabilities: opts.clientCapabilities ?? { tools: {} },
    }
  }

  get discoverResult(): DiscoverResult | undefined {
    return this._discoverResult
  }

  get metaContext(): ClientMetaContext {
    return this._metaContext
  }

  updateMetaContext(partial: Partial<ClientMetaContext>): void {
    this._metaContext = { ...this._metaContext, ...partial }
  }

  async start(): Promise<void> {
    await this.runDiscover()
  }

  async finishAuth(authorizationCode: string): Promise<void> {
    if (!this._authProvider) {
      throw new UnauthorizedError('No auth provider')
    }
    const result = await runMcpOAuthAuth(this._authProvider, {
      serverUrl: this._url,
      authorizationCode,
      resourceMetadataUrl: this._resourceMetadataUrl,
      scope: this._scope,
      // The SDK's FetchLike is declared against the global RequestInit; this transport fetches
      // through undici, whose RequestInit is a distinct (structurally near-identical) type.
      fetchFn: (url, init) => this._fetchWithInit(url, init as RequestInit),
    })
    if (result !== 'AUTHORIZED') {
      throw new UnauthorizedError('Failed to authorize')
    }
    await this.runDiscover()
  }

  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this.onclose?.()
  }

  async send(message: JSONRPCMessage | JSONRPCMessage[]): Promise<void> {
    const messages = Array.isArray(message) ? message : [message]
    for (const msg of messages) {
      await this.sendOne(msg)
    }
  }

  private async sendOne(message: JSONRPCMessage): Promise<void> {
    if (this._closed) {
      throw new Error('Transport closed')
    }

    const enriched = injectRequestMeta(message, this._metaContext)
    const headers = await this.buildHeaders(enriched)
    const res = await this._fetchWithInit(this._url, {
      method: 'POST',
      headers,
      body: JSON.stringify(enriched),
    })

    if (res.status === 401) {
      throw new UnauthorizedError('Unauthorized')
    }

    if (res.status === 202) {
      return
    }

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }

    const text = await res.text()
    if (!text.trim()) {
      return
    }

    const parsed = JSON.parse(text) as JSONRPCMessage
    if ('jsonrpc' in parsed) {
      this.onmessage?.(parsed)
    }
  }

  async runDiscover(): Promise<DiscoverResult> {
    const msg = injectRequestMeta(
      { jsonrpc: '2.0', id: `discover-${Date.now()}`, method: 'server/discover', params: {} },
      this._metaContext,
    )
    const headers = await this.buildHeaders(msg)
    const res = await this._fetchWithInit(this._url, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
    })

    if (res.status === 401) {
      throw new UnauthorizedError('Unauthorized')
    }

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`server/discover failed: HTTP ${res.status} ${text}`)
    }

    const body = (await res.json()) as { result?: DiscoverResult; error?: { message?: string } }
    if (body.error) {
      throw new Error(body.error.message ?? 'server/discover error')
    }
    if (!body.result) {
      throw new Error('server/discover returned no result')
    }

    this._discoverResult = body.result
    return body.result
  }

  private _fetchWithInit = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    // `instanceof Headers` tests the *global* class, so the operands must be typed to include it:
    // undici's HeadersInit names undici's own Headers, and narrowing by a foreign class leaves
    // `.entries` unusable. Type-only widening — the runtime check and both branches are unchanged.
    const baseHeaders: RequestInit['headers'] | globalThis.Headers = this._requestInit?.headers
    const initHeaders: RequestInit['headers'] | globalThis.Headers = init?.headers
    const mergedHeaders = {
      ...(baseHeaders instanceof Headers
        ? Object.fromEntries((baseHeaders as UndiciHeaders).entries())
        : ((baseHeaders as Record<string, string>) ?? {})),
      ...(initHeaders instanceof Headers
        ? Object.fromEntries((initHeaders as UndiciHeaders).entries())
        : ((initHeaders as Record<string, string>) ?? {})),
    }

    return fetch(url, {
      ...this._requestInit,
      ...init,
      headers: mergedHeaders,
    }) as unknown as Promise<Response>
  }

  private async buildHeaders(message: JSONRPCMessage): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': this._metaContext.protocolVersion,
    }

    if ('method' in message && message.method) {
      headers['Mcp-Method'] = message.method
      if (message.method === 'tools/call' && message.params && typeof message.params === 'object' && !Array.isArray(message.params)) {
        const name = (message.params as { name?: string }).name
        if (name) {
          headers['Mcp-Name'] = name
        }
      }
    }

    const tokens = await this._authProvider?.tokens?.()
    if (tokens?.access_token) {
      headers.Authorization = `Bearer ${tokens.access_token}`
    }

    return headers
  }
}

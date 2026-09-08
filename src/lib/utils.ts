import { OAuthClientProvider, UnauthorizedError, auth as runMcpOAuthAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReinitAwareSSEClientTransport, isReinitAwareSSETransport } from './reinit-aware-sse-transport'
import { Transport, type FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { OAuthClientInformationFull, OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import { OAuthCallbackServerOptions, StaticOAuthClientInformationFull, StaticOAuthClientMetadata } from './types'
import { NodeOAuthClientProvider } from './node-oauth-client-provider'
import { getConfigDir, getConfigFilePath, readJsonFile } from './mcp-auth-config'
import {
  discoverProtectedResourceMetadata,
  parseWWWAuthenticateHeader,
  getAuthorizationServerUrl,
  type ProtectedResourceMetadata,
} from './protected-resource-metadata'
import { fetchAuthorizationServerMetadata, type AuthorizationServerMetadata } from './authorization-server-metadata'
import { StaleClientRegistrationError } from './stale-client-registration-error'
import { SecondaryHandoffExhaustedError } from './secondary-handoff-exhausted-error'
import express from 'express'
import { Server } from 'http'
import net from 'net'
import crypto from 'crypto'
import fs from 'fs'
import { readFile, rm } from 'fs/promises'
import path from 'path'
import { EventEmitter } from 'events'
import { version as MCP_REMOTE_VERSION } from '../../package.json'
import { EnvHttpProxyAgent, fetch, Headers, RequestInit, setGlobalDispatcher } from 'undici'
import { resolveProtocolMode } from './protocol-detector.js'
import { StatelessHTTPTransport } from './stateless-http-transport.js'
import {
  buildSyntheticInitializeResult,
  DiscoverResult,
  isNonFatalSseDisconnect,
  PROTOCOL_2026_07_28,
  ProtocolMode,
  stripStatelessWireMeta,
} from './stateless-protocol.js'

// Global type declaration for typescript
declare global {
  var currentServerUrlHash: string | undefined
}

// Connection constants
export const REASON_AUTH_NEEDED = 'authentication-needed'
export const REASON_TRANSPORT_FALLBACK = 'falling-back-to-alternate-transport'
export const REASON_STALE_CLIENT_REGISTRATION = 'stale-client-registration'
/**
 * A SECONDARY instance's one-shot allowance for reconnecting with the primary's handed-over tokens
 * (#352). Kept distinct from REASON_AUTH_NEEDED so a token handoff is never starved by — and never
 * starves — a normal OAuth recovery or stale-token retry that may already have spent that budget.
 */
export const REASON_TOKEN_HANDOFF = 'token-handoff'

export type { ProtocolMode, DiscoverResult } from './stateless-protocol.js'
export { PROTOCOL_2026_07_28 } from './stateless-protocol.js'

/**
 * Which JSON-RPC methods carry an `Mcp-Name`, and where its value comes from.
 *
 * SEP-2243 sources the header from `params.name` for tools and prompts, and from
 * `params.uri` for resources.
 */
const MCP_NAME_SOURCES: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

type MirroredMcpHeaders = { method: string; name?: string }

/**
 * Read the standard MCP request headers out of a JSON-RPC body.
 *
 * A batch body is deliberately skipped: it has no single method to mirror, and
 * mirroring one of several is worse than sending nothing.
 */
function mcpHeadersFromBody(body: RequestInit['body']): MirroredMcpHeaders | undefined {
  if (typeof body !== 'string') return undefined

  let message: unknown
  try {
    message = JSON.parse(body)
  } catch {
    return undefined
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined

  const { method, params } = message as { method?: unknown; params?: unknown }
  if (typeof method !== 'string' || method.length === 0) return undefined

  const source = MCP_NAME_SOURCES[method]
  if (!source || !params || typeof params !== 'object') return { method }

  const name = (params as Record<string, unknown>)[source]
  return typeof name === 'string' && name.length > 0 ? { method, name } : { method }
}

/**
 * Encode a header value per the SEP-2243 value rules.
 *
 * RFC 9110 field values are visible ASCII plus space and tab, with no leading or
 * trailing whitespace. Anything outside that - and any literal that would itself
 * be mistaken for the sentinel - travels Base64.
 */
export function encodeMcpHeaderValue(value: string): string {
  const headerSafe = /^[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?$/.test(value)
  const looksEncoded = value.startsWith('=?base64?') && value.endsWith('?=')

  return headerSafe && !looksEncoded ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * Mirror the JSON-RPC method and target into the standard MCP request headers.
 *
 * SEP-2243 (spec revision 2026-07-28) requires `Mcp-Method` on every request and
 * `Mcp-Name` on `tools/call`, `resources/read` and `prompts/get`, so that gateways
 * can route and meter without parsing the body. The SDK sends neither, which is
 * what strands mcp-remote behind a method-aware gateway (#306).
 *
 * Both are derived from the exact body being sent, never from anything else: a
 * server that enforces the rule rejects a header that disagrees with the body -
 * or a required one that is missing - with `-32020 HeaderMismatch`. That is also
 * why `Mcp-Method` is never sent alone for a method that requires `Mcp-Name`;
 * a partial set is itself a mismatch.
 *
 * Caller-supplied headers win, so an explicit `--header` still overrides.
 *
 * The cast bridges types only: this module is undici-typed throughout (see the
 * import above) while `FetchLike` is declared against the global DOM types. They
 * are the same implementation at runtime on the Node versions we support.
 *
 * Scope note (Abluva): applied only to the legacy Streamable HTTP transports, per
 * issue #306. The 2026-07-28 StatelessHTTPTransport already emits these headers in
 * its own buildHeaders(), and the #335 header-merge / SSE paths are left untouched.
 */
const fetchWithMcpHeaders = (async (url: string | URL, init?: RequestInit) => {
  const mirrored = mcpHeadersFromBody(init?.body)
  if (!mirrored) return fetch(url, init)

  const headers = new Headers(init?.headers)
  if (!headers.has('Mcp-Method')) headers.set('Mcp-Method', mirrored.method)
  if (mirrored.name !== undefined && !headers.has('Mcp-Name')) {
    headers.set('Mcp-Name', encodeMcpHeaderValue(mirrored.name))
  }

  return fetch(url, { ...init, headers })
}) as unknown as FetchLike

// Transport strategy types
export type TransportStrategy = 'sse-only' | 'http-only' | 'sse-first' | 'http-first'
export { MCP_REMOTE_VERSION }

const pid = process.pid
// Global debug flag
export let DEBUG = false
export let SILENT = false

// Helper function for timestamp formatting
function getTimestamp(): string {
  const now = new Date()
  return now.toISOString()
}

// Debug logging function
export function debugLog(message: string, ...args: any[]) {
  if (!DEBUG) return

  const serverUrlHash = global.currentServerUrlHash
  if (!serverUrlHash) {
    console.error('[DEBUG LOG ERROR] global.currentServerUrlHash is not set. Cannot write debug log.')
    return
  }

  try {
    // Format with timestamp and PID
    const formattedMessage = `[${getTimestamp()}][${pid}] ${message}`

    // Log to console
    console.error(formattedMessage, ...args)

    // Ensure config directory exists
    const configDir = getConfigDir()
    fs.mkdirSync(configDir, { recursive: true })

    // Append to log file
    const logPath = path.join(configDir, `${serverUrlHash}_debug.log`)
    const logMessage = `${formattedMessage} ${args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ')}\n`

    fs.appendFileSync(logPath, logMessage, { encoding: 'utf8' })
  } catch (error) {
    // Fallback to console if file logging fails
    console.error(`[DEBUG LOG ERROR] ${error}`)
  }
}

export function log(str: string, ...rest: unknown[]) {
  if (!SILENT) {
    // Using stderr so that it doesn't interfere with stdout
    console.error(`[${pid}] ${str}`, ...rest)
  }

  // If debug mode is on, also log to debug file
  debugLog(str, ...rest)
}

type Message = any
const MESSAGE_BLOCKED = Symbol('MessageBlocked')
const isMessageBlocked = (value: any): value is typeof MESSAGE_BLOCKED => value === MESSAGE_BLOCKED

/** How long the client's first requests wait on `notifications/initialized` before going anyway (#310). */
const LIFECYCLE_BARRIER_TIMEOUT_MS = 10_000

/** A timer that never keeps the process alive on its own. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

export function createMessageTransformer({
  transformRequestFunction,
  transformResponseFunction,
}: {
  transformRequestFunction?: null | ((request: Message) => Message | typeof MESSAGE_BLOCKED)
  transformResponseFunction?: null | ((request: Message, response: Message) => Message)
} = {}) {
  const pendingRequests = new Map<string | number, Message>()

  /**
   * A request is the only thing worth remembering, and the only thing worth pairing a response to.
   *
   * Both directions carry id-bearing messages that are *not* requests — a response the client
   * sends back to a server-initiated call, for one — and the two directions number their requests
   * independently, so recording those would let one side's id collide with the other's and pair a
   * response with a message that never asked for it. Using `!= null` (not a truthy test) keeps the
   * JSON-RPC-legal id `0` tracked (see https://github.com/geelen/mcp-remote/issues/310).
   */
  const isRequest = (message: Message) => message?.id != null && message.method !== undefined
  const isResponse = (message: Message) => message?.id != null && message.method === undefined

  /**
   * Runs a transform, falling back to the untouched message if it throws.
   *
   * A transform is a convenience; delivery is not. Letting one throw here would abort the
   * `onmessage` handler that was about to forward the message, so a client would be left waiting
   * on a request that was in fact answered (see https://github.com/geelen/mcp-remote/issues/310).
   */
  const applyTransform = (transform: () => Message, message: Message) => {
    try {
      return transform()
    } catch (error) {
      log('Error transforming message, forwarding it unchanged:', error)
      debugLog('Message transform failed', { id: message?.id, method: message?.method, error })
      return message
    }
  }

  const interceptRequest = (message: Message) => {
    if (!isRequest(message)) return message
    pendingRequests.set(message.id, message)
    if (!transformRequestFunction) return message
    return applyTransform(() => transformRequestFunction(message) ?? message, message)
  }

  const interceptResponse = (message: Message) => {
    if (!isResponse(message)) return message
    const originalRequest = pendingRequests.get(message.id)
    if (!originalRequest) return message
    pendingRequests.delete(message.id)
    if (!transformResponseFunction) return message
    return applyTransform(() => transformResponseFunction(originalRequest, message) ?? message, message)
  }

  return {
    interceptRequest,
    interceptResponse,
  }
}

/**
 * Creates a bidirectional proxy between two transports
 * @param params The transport connections to proxy between
 */
function isRecoverableAuthError(error: Error): boolean {
  if (error instanceof UnauthorizedError) return true
  if (error instanceof StreamableHTTPError && error.code === 401) return true
  if (error instanceof OAuthError) {
    const msg = error.message?.toLowerCase() ?? ''
    if (msg.includes('refresh_token') || msg.includes('invalid_token') || msg.includes('unauthorized')) {
      return true
    }
    if (error.errorCode === 'invalid_request' || error.errorCode === 'invalid_token') {
      return true
    }
  }
  const msg = error.message?.toLowerCase() ?? ''
  return msg.includes('unauthorized') || msg.includes('401 after successful authentication')
}

function resetTransportAuthState(transport: Transport): void {
  const t = transport as StreamableHTTPClientTransport & { _hasCompletedAuthFlow?: boolean }
  if (t && '_hasCompletedAuthFlow' in t) {
    t._hasCompletedAuthFlow = false
  }
}

/** SDK throws this when OAuth refresh succeeded but the server still returned 401 on retry. */
export function isStalePostAuth401Error(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError &&
    error.code === 401 &&
    error.message.includes('401 after successful authentication')
  )
}

async function reconnectAfterStaleOAuthAtConnect(
  error: unknown,
  options: {
    authProvider: OAuthClientProvider
    transport: Transport
    authChallengeTransport?: Transport
    authInitializer: AuthInitializer
    serverUrl: string
    recursionReasons: Set<string>
    reconnect: () => Promise<Transport>
  },
): Promise<Transport> {
  log('Rejected OAuth token at connect — clearing stale credentials and re-authenticating...')
  try {
    if (typeof (options.authProvider as { invalidateCredentials?: (scope: string) => Promise<void> }).invalidateCredentials === 'function') {
      await options.authProvider.invalidateCredentials('tokens')
    }
  } catch (invalidateError) {
    debugLog('Failed to invalidate cached OAuth tokens at connect', { invalidateError })
  }
  resetTransportAuthState(options.transport)
  if (options.authChallengeTransport) {
    resetTransportAuthState(options.authChallengeTransport)
  }

  if (options.recursionReasons.has(REASON_AUTH_NEEDED)) {
    throw error instanceof Error ? error : new Error(String(error))
  }

  const { waitForAuthCode, skipBrowserAuth, callbackPort } = await options.authInitializer(true)

  if (!skipBrowserAuth && callbackPort > 0) {
    await waitForCallbackServer(callbackPort)
  }

  if (!skipBrowserAuth && options.serverUrl) {
    const authResult = await runMcpOAuthAuth(options.authProvider, { serverUrl: options.serverUrl })
    if (authResult === 'REDIRECT') {
      log(`Opened browser for MCP re-authentication at connect (callback port ${callbackPort ?? 'unknown'})`)
    }
  } else if (skipBrowserAuth) {
    log('Authentication required but skipping browser auth - using shared auth')
  } else {
    log('Authentication required. Waiting for authorization...')
  }

  const code = await waitForAuthCode()
  log('Completing authorization after stale token rejection at connect...')
  const finishTarget = options.authChallengeTransport ?? options.transport
  if (!('finishAuth' in finishTarget) || typeof finishTarget.finishAuth !== 'function') {
    throw new Error('Transport does not support finishAuth')
  }
  await finishTarget.finishAuth(code)

  options.recursionReasons.add(REASON_AUTH_NEEDED)
  log(`Recursively reconnecting for reason: ${REASON_AUTH_NEEDED}`)
  return options.reconnect()
}

/**
 * Ownership-gated, bounded recovery for a stale/immediately-rejected dynamic OAuth client
 * registration (#299).
 *
 * The provider only DETECTS staleness (it does not delete shared OAuth state). Recovery must be
 * gated on cross-process (#17) ownership so a secondary never invalidates files the primary is
 * using:
 *   - authInitializer() (no force) establishes/learns ownership via the existing coordinator.
 *   - PRIMARY / took-over (skipBrowserAuth === false): invalidate all cached credentials, then
 *     reconnect; the SDK then performs fresh dynamic client registration -> normal OAuth.
 *   - SECONDARY (skipBrowserAuth === true): the coordinator already waited for the primary to
 *     finish and write fresh client_info + tokens to disk; do NOT invalidate anything, just
 *     reconnect and reuse the primary's recovered state from disk.
 *
 * Retry is bounded to exactly once via the shared recursionReasons set. authInitializer() is
 * called WITHOUT a force argument so this never resets/re-elects #17 coordination.
 */
async function recoverFromStaleClientRegistration(
  error: StaleClientRegistrationError,
  options: {
    authProvider: OAuthClientProvider
    authInitializer: AuthInitializer
    recursionReasons: Set<string>
    reconnect: () => Promise<Transport>
  },
): Promise<Transport> {
  if (options.recursionReasons.has(REASON_STALE_CLIENT_REGISTRATION)) {
    throw error
  }
  options.recursionReasons.add(REASON_STALE_CLIENT_REGISTRATION)

  const { skipBrowserAuth } = await options.authInitializer()

  if (!skipBrowserAuth) {
    if (
      typeof (options.authProvider as { invalidateCredentials?: (scope: string) => Promise<void> })
        .invalidateCredentials === 'function'
    ) {
      log('Stale OAuth client registration — primary clearing credentials before fresh registration')
      await options.authProvider.invalidateCredentials('all')
    } else {
      // Cannot clear the stale client registration — fail clearly and never reconnect with stale state.
      log('Stale OAuth client registration — provider cannot clear it; failing without reconnect')
      throw error
    }
  } else {
    log('Stale OAuth client registration — secondary reusing primary recovery (no invalidation)')
  }

  log(`Recursively reconnecting for reason: ${REASON_STALE_CLIENT_REGISTRATION}`)
  return options.reconnect()
}

/**
 * The result of the secondary token-handoff ladder.
 *
 * - `connected`: a reconnect was performed (Step A disk re-read, or the Step B recovery reconnect)
 *   and produced a transport to return to the caller.
 * - `takeover`: the primary vanished and the coordinator elected THIS instance primary, so the
 *   caller should fall through to its normal browser-auth flow using the returned callback.
 */
type SecondaryHandoffOutcome =
  | { kind: 'connected'; transport: Transport }
  | { kind: 'takeover'; waitForAuthCode: () => Promise<string>; callbackPort: number }

/**
 * Bounded recovery for a SECONDARY instance whose 401 was answered by a token handoff (#352).
 *
 * The retry budget is split from normal OAuth recovery so a handoff always gets its own allowance,
 * yet remains strictly bounded via two distinct one-shot reasons in the shared `recursionReasons`
 * set:
 *
 *   Step A (REASON_TOKEN_HANDOFF, once): reconnect and let the auth provider re-read the primary's
 *     tokens from disk. This preserves the existing #322 behavior — no browser, no coordination
 *     reset — for the common "tokens were just written" case.
 *
 *   Step B (REASON_AUTH_NEEDED, once): the handed-over tokens still failed. Attempt exactly one
 *     coordinated recovery via authInitializer(true). The exclusive callback-port bind (#17) makes
 *     a duplicate primary impossible:
 *       - primary still alive  -> we re-coordinate as a secondary and re-poll its tokens, then
 *         reconnect once more (bounded by REASON_AUTH_NEEDED);
 *       - primary gone         -> the coordinator elected us primary, so we hand control back to
 *         the caller's normal browser-auth flow (`takeover`).
 *
 * When both allowances are spent while the primary still owns coordination, this throws
 * SecondaryHandoffExhaustedError — a benign terminal the proxy turns into a quiet exit only once a
 * live primary is confirmed.
 */
async function handleSecondaryTokenHandoff(options: {
  recursionReasons: Set<string>
  authInitializer: AuthInitializer
  reconnect: () => Promise<Transport>
}): Promise<SecondaryHandoffOutcome> {
  const { recursionReasons, authInitializer, reconnect } = options

  // Step A: one bounded reconnect re-reading the primary's tokens from disk (#322).
  if (!recursionReasons.has(REASON_TOKEN_HANDOFF)) {
    recursionReasons.add(REASON_TOKEN_HANDOFF)
    log('Authentication completed by another instance - reconnecting with the tokens it wrote')
    return { kind: 'connected', transport: await reconnect() }
  }

  // Step B: the handed-over tokens were rejected. One coordinated recovery, bounded separately.
  if (recursionReasons.has(REASON_AUTH_NEEDED)) {
    // Handoff reconnect and coordinated recovery are both spent, and we are still a secondary:
    // there is nothing left to try without becoming a duplicate primary.
    throw new SecondaryHandoffExhaustedError()
  }

  log('Handed-over tokens were rejected - attempting one coordinated auth recovery')
  const recovery = await authInitializer(true)

  if (recovery.skipBrowserAuth) {
    // Primary still owns the callback port; we re-coordinated as a secondary and re-polled its
    // tokens. Reconnect once more — if this still fails, the next pass hits the exhausted throw
    // above (REASON_AUTH_NEEDED is now set), so recovery stays bounded to a single attempt.
    recursionReasons.add(REASON_AUTH_NEEDED)
    log('Coordinated recovery kept this instance secondary - reconnecting once with refreshed tokens')
    return { kind: 'connected', transport: await reconnect() }
  }

  // Primary vanished: the coordinator elected THIS instance primary (the exclusive port bind
  // guarantees there is no other). Hand control back so the caller runs its normal browser-auth
  // flow with the freshly elected primary's callback. REASON_AUTH_NEEDED is deliberately NOT set
  // here so that flow keeps its own one-shot budget.
  log('Primary instance is no longer coordinating - taking over to authenticate directly')
  return { kind: 'takeover', waitForAuthCode: recovery.waitForAuthCode, callbackPort: recovery.callbackPort }
}

export function isLocalHttpServer(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl)
    return (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:'
  } catch {
    return false
  }
}

export async function isCallbackServerListening(port: number, probeTimeoutMs = 750): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/wait-for-auth?poll=false`, {
      signal: AbortSignal.timeout(probeTimeoutMs),
    })
    return response.status === 200 || response.status === 202
  } catch {
    return false
  }
}

export async function waitForCallbackServer(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/wait-for-auth?poll=false`, {
        signal: AbortSignal.timeout(750),
      })
      if (response.status === 200 || response.status === 202) {
        log(`OAuth callback server is ready on port ${port}`)
        return
      }
    } catch {
      // retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`OAuth callback server is not listening on port ${port}`)
}

/**
 * Bidirectional stdio ↔ remote HTTP proxy.
 *
 * Legacy path (`--protocol legacy`): forwards initialize and session traffic to Streamable HTTP.
 * Stateless path (`--protocol 2026-07-28`): remote uses POST-only v2 wire format; stdio clients
 * (Claude, MCP Inspector legacy era) still speak 2025-11-25, so we shim initialize and optional
 * list methods locally and strip v2 `_meta` from responses.
 */
export function mcpProxy({
  transportToClient,
  transportToServer,
  ignoredTools = [],
  authInitializer,
  authProvider,
  serverUrl,
  events,
  callbackPort,
  remoteProtocolMode = 'legacy',
  discoverResult,
}: {
  transportToClient: Transport
  transportToServer: Transport | SSEClientTransport | StreamableHTTPClientTransport | StatelessHTTPTransport
  ignoredTools?: string[]
  authInitializer?: AuthInitializer
  authProvider?: NodeOAuthClientProvider
  serverUrl?: string
  events?: EventEmitter
  callbackPort?: number
  remoteProtocolMode?: 'legacy' | typeof PROTOCOL_2026_07_28
  discoverResult?: DiscoverResult
}) {
  let transportToClientClosed = false
  let transportToServerClosed = false
  let lastOutboundRequest: Message | undefined
  let authRecoveryInFlight: Promise<void> | null = null

  // --- Legacy SSE session recovery state (issue #269) ---
  // The client's initialize request, cached so it can be replayed verbatim onto a new SSE
  // session after an EventSource reconnect rotated the endpoint/session id.
  let lastInitialize: Message | undefined
  // Single-flight guard: several rotations / requests coalesce into one re-initialize.
  let reinitInFlight: Promise<void> | null = null
  // Monotonic counter for the internal (sentinel) re-initialize request id.
  let reinitSeq = 0
  // Sentinel reinit ids awaiting their response; consumed by the proxy, never forwarded to client.
  const pendingReinit = new Map<string, (message: Message) => void>()

  // Track in-flight request ids so transport-level onerror (e.g. SSE 429) can unblock
  // waiting clients with JSON-RPC errors instead of hanging indefinitely.
  const pendingRequests = new Map<string | number, true>()

  // --- Startup lifecycle barrier (issue #310) ---
  // Set once the client's `notifications/initialized` has been forwarded; the client's first
  // requests wait on this so a strict remote does not see tools/list before the session is
  // initialized. Null until then, and never reset — post-startup this resolves immediately, so
  // it gates ordering without serializing normal traffic.
  let initializedDelivered: Promise<unknown> | null = null

  const messageTransformer = createMessageTransformer({
    transformRequestFunction: (request: Message) => {
      // Block tools/call for ignored tools
      if (request.method === 'tools/call' && request.params?.name) {
        const toolName = request.params.name
        if (!shouldIncludeTool(ignoredTools, toolName)) {
          // Send error response back to client immediately
          const errorResponse = {
            jsonrpc: '2.0' as const,
            id: request.id,
            error: {
              code: -32603,
              message: `Tool "${toolName}" is not available`,
            },
          }
          transportToClient.send(errorResponse).catch(onClientError)
          // Return symbol to indicate this request should not be forwarded
          return MESSAGE_BLOCKED
        }
      }
      return request
    },
    transformResponseFunction: (req: Message, res: Message) => {
      // Not every answer to tools/list carries a tool list: a JSON-RPC error response has no
      // `result` at all, and a server may answer with a result that omits `tools` (or sends a
      // non-array in its place). Only filter when there is actually an array to filter; otherwise
      // forward the server's own answer, so the client gets the error/result the server sent
      // rather than a dropped or crashed response (see issues #164 and #310).
      const tools = req.method === 'tools/list' ? res.result?.tools : undefined
      if (Array.isArray(tools)) {
        return {
          ...res,
          result: {
            ...(remoteProtocolMode === PROTOCOL_2026_07_28 ? stripStatelessWireMeta(res.result) : res.result),
            tools: tools.filter((tool: any) => shouldIncludeTool(ignoredTools, tool.name)),
          },
        }
      }

      // No tool array to filter (tools/list error/no-tools, or any other response): preserve the
      // Abluva stateless wire-meta strip, but never assume a tools array exists.
      if (remoteProtocolMode === PROTOCOL_2026_07_28 && res.result) {
        return {
          ...res,
          result: stripStatelessWireMeta(res.result),
        }
      }
      return res
    },
  })

  function replyLocalResult(id: string | number | undefined, result: Record<string, unknown>) {
    if (id === undefined || id === null) return
    transportToClient
      .send({
        jsonrpc: '2.0',
        id,
        result,
      })
      .catch(onClientError)
  }

  function shimEmptyListMethod(method: string, id: string | number | undefined, resultKey: string) {
    log(`[Local shim] ${method} → empty`)
    replyLocalResult(id, { [resultKey]: [] })
  }

  transportToClient.onmessage = (_message) => {
    // TODO: fix types
    const raw = _message as Message

    log('[Client→Local]', raw.method || raw.id)

    // Stdio clients (Claude, Inspector legacy era) often call these after tools/list.
    // Tool-only remotes typically don't implement them — answer locally to avoid -32601 hangs.
    if (raw.method === 'prompts/list') {
      shimEmptyListMethod('prompts/list', raw.id, 'prompts')
      return
    }
    if (raw.method === 'resources/list') {
      shimEmptyListMethod('resources/list', raw.id, 'resources')
      return
    }
    if (raw.method === 'resources/templates/list') {
      shimEmptyListMethod('resources/templates/list', raw.id, 'resourceTemplates')
      return
    }
    if (raw.method === 'tasks/list') {
      shimEmptyListMethod('tasks/list', raw.id, 'tasks')
      return
    }
    if (raw.method === 'ping') {
      log('[Local shim] ping → ok')
      replyLocalResult(raw.id, {})
      return
    }

    // Stateless remote: satisfy Claude's legacy stdio requests locally before forwarding.
    if (remoteProtocolMode === PROTOCOL_2026_07_28) {
      if (raw.method === 'initialize') {
        const requestedVersion = raw.params?.protocolVersion
        if (transportToServer instanceof StatelessHTTPTransport) {
          transportToServer.updateMetaContext({
            clientInfo: raw.params?.clientInfo ?? { name: 'mcp-remote-client', version: '0.0.0' },
            clientCapabilities: raw.params?.capabilities ?? { tools: {} },
          })
        }
        const initResult = buildSyntheticInitializeResult(discoverResult ?? {}, requestedVersion, {
          shimForLocalClient: true,
        })
        log('[Local shim] Answering initialize locally for stateless remote')
        debugLog('Synthetic initialize result', { protocolVersion: initResult.protocolVersion })
        replyLocalResult(raw.id, initResult)
        return
      }
      if (raw.method === 'notifications/initialized') {
        log('[Local shim] Swallowing notifications/initialized')
        return
      }
    }

    const message = messageTransformer.interceptRequest(raw as any)

    // If interceptor returns MESSAGE_BLOCKED, don't forward the message
    if (isMessageBlocked(message)) {
      return
    }

    log('[Local→Remote]', message.method || message.id)

    debugLog('Local → Remote message', {
      method: message.method,
      id: message.id,
      params: message.params ? JSON.stringify(message.params).substring(0, 500) : undefined,
    })

    if (message.method === 'initialize') {
      const { clientInfo } = message.params
      if (clientInfo) clientInfo.name = `${clientInfo.name} (via mcp-remote ${MCP_REMOTE_VERSION})`
      log(JSON.stringify(message, null, 2))

      debugLog('Initialize message with modified client info', { clientInfo })

      // Cache the (mutated) initialize so it can be replayed onto a rotated SSE session (#269).
      lastInitialize = message
    }

    forwardInOrder(message)
  }

  /**
   * Forwards a message, keeping the client's first requests behind `notifications/initialized`.
   *
   * Every forward here is an independent POST, and a client sends the notification and its first
   * requests back to back, so without this they race — and a strict remote answers whichever
   * request wins with `-32600 Session not initialized`. The spec puts the same rule on the client,
   * which it honours over stdio; only the proxy was re-ordering it on the wire (issue #310).
   *
   * This layers on top of the existing #269 gating rather than replacing it: `sendToServer` still
   * waits out any in-flight OAuth/SSE recovery internally. Nothing else is serialized — once the
   * notification has settled, `initializedDelivered` is already resolved, so later requests fan
   * out through `sendToServer` without waiting on each other.
   */
  function forwardInOrder(message: Message): void {
    if (message.method === 'notifications/initialized') {
      // Bounded, because a server that never accepts the notification must not leave every later
      // request queued behind it forever — racing ahead is the lesser failure.
      initializedDelivered = Promise.race([sendToServer(message), sleep(LIFECYCLE_BARRIER_TIMEOUT_MS)])
      return
    }

    if (initializedDelivered) {
      // Continuations resume in the order they were queued, so this preserves the client's order
      // among the messages waiting on the notification, not just their order relative to it.
      void initializedDelivered.then(() => sendToServer(message))
      return
    }

    void sendToServer(message)
  }

  /**
   * Forwards a client request/notification to the remote server.
   *
   * Fast path (the overwhelmingly common case): no recovery is in progress, so forward
   * synchronously — identical to the pre-#269 behaviour.
   *
   * Gated path (issue #269): while an OAuth recovery or SSE re-initialize is in flight, wait for
   * both to settle first so a normal request never races ahead of the fresh session handshake.
   *
   * Returns a promise that settles once the underlying send has settled (including any recovery
   * wait), so the #310 lifecycle barrier can await delivery of `notifications/initialized`.
   */
  function sendToServer(message: Message): Promise<void> {
    if (!authRecoveryInFlight && !reinitInFlight) {
      return dispatchToServer(message)
    }
    return settleRecoveries().then(() => dispatchToServer(message))
  }

  function dispatchToServer(message: Message): Promise<void> {
    lastOutboundRequest = message
    const requestId = 'id' in message ? message.id : undefined
    if (requestId !== undefined) {
      pendingRequests.set(requestId, true)
    }

    return transportToServer.send(message).catch((error: Error) => {
      if (requestId !== undefined) {
        pendingRequests.delete(requestId)
      }
      if (isRecoverableAuthError(error) && authInitializer) {
        void onSendError(error, message)
        return
      }
      onServerError(error)
      if (requestId !== undefined) {
        transportToClient
          .send({
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: -32603,
              message: error.message ?? 'Internal error forwarding request to remote server',
            },
          })
          .catch(onClientError)
      }
    })
  }

  transportToServer.onmessage = (_message) => {
    // Responses to our own internal re-initialize handshake are ours to consume, never the
    // client's (issue #269). They carry a sentinel id we minted in doReinitializeSession.
    const reinitId = (_message as Message)?.id
    if (typeof reinitId === 'string' && pendingReinit.has(reinitId)) {
      const settle = pendingReinit.get(reinitId)!
      pendingReinit.delete(reinitId)
      settle(_message as Message)
      return
    }

    // TODO: fix types
    const message = messageTransformer.interceptResponse(_message as any)
    log('[Remote→Local]', message.method || message.id)

    debugLog('Remote → Local message', {
      method: message.method,
      id: message.id,
      result: message.result ? 'result-present' : undefined,
      error: message.error,
    })

    if (message.id !== undefined && message.id !== null) {
      pendingRequests.delete(message.id as string | number)
    }

    transportToClient.send(message).catch(onClientError)
  }

  transportToClient.onclose = () => {
    if (transportToServerClosed) {
      return
    }

    transportToClientClosed = true
    debugLog('Local transport closed, closing remote transport')
    transportToServer.close().catch(onServerError)
  }

  transportToServer.onclose = () => {
    if (transportToClientClosed) {
      return
    }
    transportToServerClosed = true
    debugLog('Remote transport closed, closing local transport')
    transportToClient.close().catch(onClientError)
  }

  transportToClient.onerror = onClientError
  transportToServer.onerror = onServerError

  // Legacy SSE only (#269): when the EventSource reconnects onto a new session, replay the
  // handshake. The stateless 2026-07-28 path uses StatelessHTTPTransport and is never wired here.
  if (isReinitAwareSSETransport(transportToServer)) {
    transportToServer.onSessionRotated = () => {
      void handleSseSessionRotated()
    }
  }

  function onClientError(error: Error) {
    log('Error from local client:', error)
    debugLog('Error from local client', { stack: error.stack })
  }

  function drainPendingRequests(error: Error) {
    if (pendingRequests.size === 0) {
      return
    }
    const errorMsg = error.message ?? 'Remote server error'
    for (const id of pendingRequests.keys()) {
      transportToClient
        .send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: errorMsg,
          },
        })
        .catch(onClientError)
    }
    pendingRequests.clear()
  }

  function onServerError(error: Error) {
    if (isNonFatalSseDisconnect(error, pendingRequests.size)) {
      debugLog('Ignoring non-fatal SSE stream disconnect', { message: error.message })
      return
    }
    log('Error from remote server:', error)
    debugLog('Error from remote server', { stack: error.stack })
    if (isRecoverableAuthError(error) && authInitializer) {
      // While an SSE re-initialize is running, it owns auth recovery. Ensure the OAuth flow is
      // (single-flight) running so the reinit handshake can resume, but do NOT start a competing
      // normal-request retry here — normal requests are gated behind settleRecoveries (#269).
      if (reinitInFlight) {
        void ensureAuthRecovered()
        return
      }
      void onSendError(error, lastOutboundRequest)
      return
    }
    drainPendingRequests(error)
  }

  async function replyAuthErrorToClient(failedMessage: Message | undefined, message: string) {
    if (failedMessage?.id === undefined) return
    await transportToClient.send({
      jsonrpc: '2.0',
      id: failedMessage.id,
      error: {
        code: -32001,
        message,
      },
    })
  }

  /**
   * Single-flight OAuth recovery core: invalidate stale tokens, run the auth flow, and finish it
   * on the transport. Does NOT retry any application message — that stays the caller's concern so
   * this primitive can be shared by both the normal-request path (onSendError) and the SSE
   * re-initialize path (doReinitializeSession) without duplicating a handshake.
   */
  function ensureAuthRecovered(): Promise<void> {
    if (!authInitializer) return Promise.resolve()
    if (authRecoveryInFlight) return authRecoveryInFlight

    authRecoveryInFlight = (async () => {
      log('Authentication required during active session — clearing stale tokens and re-authenticating...')
      try {
        await authProvider?.invalidateCredentials('tokens')
      } catch (invalidateError) {
        debugLog('Failed to invalidate cached OAuth tokens', { invalidateError })
      }
      events?.emit('reset-auth-code')

      debugLog('ensureAuthRecovered: Calling authInitializer to start auth flow')
      const authState = await authInitializer(true)

      if (!authState.skipBrowserAuth && callbackPort) {
        await waitForCallbackServer(callbackPort)
      }

      if (!authState.skipBrowserAuth && authProvider && serverUrl) {
        const authResult = await runMcpOAuthAuth(authProvider, { serverUrl })
        if (authResult === 'REDIRECT') {
          log(`Opened browser for MCP re-authentication (callback port ${callbackPort ?? 'unknown'})`)
        }
      } else if (authState.skipBrowserAuth) {
        log('Authentication required but skipping browser auth - using shared auth')
      } else {
        log('Authentication required. Waiting for authorization...')
      }

      debugLog('ensureAuthRecovered: Waiting for auth code from callback server')
      const code = await authState.waitForAuthCode()
      debugLog('ensureAuthRecovered: Received auth code from callback server')

      log('ensureAuthRecovered: Completing authorization...')
      resetTransportAuthState(transportToServer)
      if ('finishAuth' in transportToServer && typeof transportToServer.finishAuth === 'function') {
        await transportToServer.finishAuth(code)
        log('ensureAuthRecovered: Authorization completed successfully')
      } else {
        throw new Error('Transport does not support finishAuth')
      }
    })().finally(() => {
      authRecoveryInFlight = null
    })

    return authRecoveryInFlight
  }

  async function onSendError(error: Error, failedMessage?: Message) {
    if (!isRecoverableAuthError(error) || !authInitializer) {
      return
    }

    try {
      await ensureAuthRecovered()
    } catch (authError) {
      log('onSendError: Error completing authorization:', authError)
      await replyAuthErrorToClient(
        failedMessage,
        authError instanceof Error
          ? authError.message
          : 'MCP OAuth session expired — sign in again in your browser',
      )
      return
    }

    resetTransportAuthState(transportToServer)
    // Ordering (#269): if an SSE re-initialize is also in flight, let it finish so the retried
    // request lands on the fresh, initialized session rather than racing ahead of the handshake.
    await reinitInFlight?.catch(() => {})

    if (failedMessage) {
      try {
        log('onSendError: Retrying failed message after re-authentication')
        await transportToServer.send(failedMessage)
        log('onSendError: Message successfully sent after re-authentication')
      } catch (retryError) {
        await replyAuthErrorToClient(
          failedMessage,
          retryError instanceof Error ? retryError.message : 'MCP authentication failed after re-sign-in',
        )
      }
    }
  }

  // --- Legacy SSE session recovery (issue #269) ---

  /** Waits for any in-flight OAuth recovery and SSE re-initialize to settle, in that precedence. */
  async function settleRecoveries(): Promise<void> {
    // Loop because a reinit may begin (and itself start OAuth recovery) after we first observe it.
    // Both promises are single-flight, so this settles.
    while (authRecoveryInFlight || reinitInFlight) {
      await authRecoveryInFlight?.catch(() => {})
      await reinitInFlight?.catch(() => {})
    }
  }

  /** The new session negotiates its own protocol version; the header must follow it. */
  function applyNegotiatedProtocolVersion(response: Message): void {
    const protocolVersion = response?.result?.protocolVersion
    if (typeof protocolVersion === 'string') {
      debugLog('Applying negotiated protocol version after SSE reinit', { protocolVersion })
      ;(transportToServer as { setProtocolVersion?: (version: string) => void }).setProtocolVersion?.(protocolVersion)
    }
  }

  function handleSseSessionRotated(): Promise<void> {
    if (!lastInitialize) {
      debugLog('SSE session rotated but no cached initialize seen; skipping re-initialize')
      return Promise.resolve()
    }
    return reinitializeSession().catch((error) => {
      // Log-only: never feed this back into onServerError, or we could spawn a competing recovery.
      log('SSE re-initialize failed:', error instanceof Error ? error.message : String(error))
      debugLog('SSE re-initialize failed', { error })
    })
  }

  /** Coalesces concurrent rotations/requests so a dead session produces exactly one new session. */
  function reinitializeSession(): Promise<void> {
    if (!reinitInFlight) {
      reinitInFlight = doReinitializeSession().finally(() => {
        reinitInFlight = null
      })
    }
    return reinitInFlight
  }

  async function doReinitializeSession(): Promise<void> {
    if (!lastInitialize) {
      throw new Error('No cached initialize request; cannot re-establish the SSE session')
    }

    // Never replay the handshake on a token OAuth is mid-way through refreshing.
    await authRecoveryInFlight?.catch(() => {})

    try {
      await sendReinitHandshake()
      return
    } catch (error) {
      // A recoverable auth error means the fresh session needs (re-)authentication. Reuse any
      // OAuth recovery already started by the transport's onerror, then retry the handshake once.
      if (!isRecoverableAuthError(error as Error) || !authInitializer) {
        throw error
      }
      log('SSE re-initialize hit an auth error; recovering OAuth then retrying handshake once')
      await ensureAuthRecovered()
      resetTransportAuthState(transportToServer)
      await sendReinitHandshake()
    }
  }

  async function sendReinitHandshake(): Promise<void> {
    const id = `mcp-remote-reinit-${++reinitSeq}`
    const response = await new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReinit.delete(id)
        reject(new Error('Timed out waiting for the re-initialize response'))
      }, 30000)
      pendingReinit.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      transportToServer.send({ ...lastInitialize, id }).catch((error) => {
        clearTimeout(timer)
        pendingReinit.delete(id)
        reject(error)
      })
    })

    if (response.error) {
      throw new Error(`Server rejected re-initialize: ${JSON.stringify(response.error)}`)
    }

    applyNegotiatedProtocolVersion(response)
    // The SDK only (re)opens the standalone GET SSE stream when it sees this notification.
    await transportToServer.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    log('Re-established SSE session after endpoint rotation (issue #269)')
  }
}

/**
 * Result of OAuth server discovery
 */
export interface OAuthServerDiscoveryResult {
  /** The URL of the authorization server to use for OAuth */
  authorizationServerUrl: string
  /** Authorization server metadata (if successfully fetched) */
  authorizationServerMetadata?: AuthorizationServerMetadata
  /** Protected resource metadata (if discovered) */
  protectedResourceMetadata?: ProtectedResourceMetadata
  /** Scope extracted from WWW-Authenticate header */
  wwwAuthenticateScope?: string
  /**
   * True when the initial probe reached the server successfully without authentication
   * (HTTP 200). Callers can use this to skip eager OAuth callback-server coordination so a
   * secondary instance does not block forever waiting for an auth flow that never happens.
   */
  serverAccessibleWithoutAuth?: boolean
}

/**
 * Probes the MCP server to discover the authorization server via Protected Resource Metadata.
 *
 * This implements the MCP Authorization Server Discovery flow:
 * 1. Make a request to the MCP server
 * 2. If we get a 401, extract the WWW-Authenticate header
 * 3. Use the resource_metadata URL from the header (if present) or well-known URIs
 * 4. Fetch Protected Resource Metadata to get the authorization server URL
 * 5. Fetch Authorization Server Metadata from the discovered server
 *
 * @param serverUrl The MCP server URL
 * @param headers Optional headers to include in the probe request
 * @returns Discovery result with authorization server URL and metadata
 */
export async function discoverOAuthServerInfo(
  serverUrl: string,
  headers: Record<string, string> = {},
): Promise<OAuthServerDiscoveryResult> {
  debugLog('Starting OAuth server discovery', { serverUrl })

  let wwwAuthenticateHeader: string | undefined
  let wwwAuthenticateScope: string | undefined

  // Step 1: Probe the MCP server to get WWW-Authenticate header
  try {
    debugLog('Probing MCP server for WWW-Authenticate header')
    const response = await fetch(serverUrl, {
      method: 'GET',
      headers: {
        ...headers,
        Accept: 'application/json, text/event-stream',
      },
      signal: AbortSignal.timeout(10000),
    })

    // If we get a successful response, the server doesn't require auth
    // Fall back to using serverUrl as authorization server
    if (response.ok) {
      debugLog('Server responded OK without auth, using server URL as authorization server')
      const authServerMetadata = await fetchAuthorizationServerMetadata(serverUrl)
      return {
        authorizationServerUrl: serverUrl,
        authorizationServerMetadata: authServerMetadata,
        serverAccessibleWithoutAuth: true,
      }
    }

    // Check for 401 Unauthorized
    if (response.status === 401) {
      wwwAuthenticateHeader = response.headers.get('WWW-Authenticate') || undefined
      debugLog('Received 401 with WWW-Authenticate header', {
        hasHeader: !!wwwAuthenticateHeader,
        header: wwwAuthenticateHeader,
      })

      // Parse scope from WWW-Authenticate header if present
      if (wwwAuthenticateHeader) {
        const params = parseWWWAuthenticateHeader(wwwAuthenticateHeader)
        wwwAuthenticateScope = params.scope
      }
    }
  } catch (error) {
    debugLog('Error probing MCP server', {
      error: error instanceof Error ? error.message : String(error),
    })
    // Continue with discovery even if probe fails
  }

  // Step 2: Discover Protected Resource Metadata
  const protectedResourceMetadata = await discoverProtectedResourceMetadata(serverUrl, wwwAuthenticateHeader)

  // Step 3: Determine authorization server URL
  let authorizationServerUrl: string

  if (protectedResourceMetadata) {
    const discoveredUrl = getAuthorizationServerUrl(protectedResourceMetadata)
    if (discoveredUrl) {
      authorizationServerUrl = discoveredUrl
      debugLog('Using authorization server from Protected Resource Metadata', {
        authorizationServerUrl,
      })
    } else {
      // PRM found but no authorization_servers - fall back to server URL
      authorizationServerUrl = serverUrl
      debugLog('PRM found but no authorization_servers, falling back to server URL')
    }
  } else {
    // No PRM found - fall back to server URL (current behavior)
    authorizationServerUrl = serverUrl
    debugLog('No Protected Resource Metadata found, falling back to server URL as authorization server')
  }

  // Step 4: Fetch Authorization Server Metadata
  const authorizationServerMetadata = await fetchAuthorizationServerMetadata(authorizationServerUrl)

  return {
    authorizationServerUrl,
    authorizationServerMetadata,
    protectedResourceMetadata,
    wwwAuthenticateScope,
  }
}

/**
 * Type for the auth initialization function
 */
export type AuthInitializer = (forceReauth?: boolean) => Promise<{
  waitForAuthCode: () => Promise<string>
  skipBrowserAuth: boolean
  callbackPort: number
}>

/** The header shapes `fetch` accepts, plus the `Headers` the SDK actually hands over. */
type HeaderSource = RequestInit['headers'] | Headers | globalThis.Headers | undefined

function headerEntries(source: HeaderSource): Array<[string, string]> {
  if (!source) return []
  // Arrays have `entries` too, so this order matters - theirs yields [index, pair], not [name, value]
  if (Array.isArray(source)) return source as Array<[string, string]>
  const iterable = source as { entries?: () => Iterable<[string, string]> }
  if (typeof iterable.entries === 'function') return [...iterable.entries()]
  return Object.entries(source as Record<string, string>)
}

/**
 * Merges header sources into one plain object, with later sources winning.
 *
 * Two things make this less trivial than a spread.
 *
 * The sources are different shapes. The SDK hands over a `Headers` built from the *global* class,
 * while the check here used to be `instanceof Headers` against the one imported from undici - a
 * different class, so it never matched, and the fallback spread of a `Headers` yields no own
 * properties at all. Every header the SDK had set was dropped (see
 * https://github.com/geelen/mcp-remote/issues/157). Duck-typing on `entries` accepts either.
 *
 * And the sources disagree about case. `Headers.entries()` lowercases, while `--header` values and
 * the ones added here keep the case they were written in, so a plain merge emits `authorization`
 * *and* `Authorization` as separate keys - which `fetch` then joins into a single comma-separated
 * value that no server will accept. Merging case-insensitively keeps one entry per header, spelled
 * the way its last writer spelled it, so a server matching on `Company` still sees `Company`.
 *
 * @param sources Header collections in precedence order, lowest first
 * @returns The merged headers
 */
export function mergeHeaders(...sources: HeaderSource[]): Record<string, string> {
  const merged = new Map<string, [string, string]>()
  for (const source of sources) {
    for (const [name, value] of headerEntries(source)) {
      merged.set(name.toLowerCase(), [name, value])
    }
  }
  return Object.fromEntries(merged.values())
}

/**
 * Creates and connects to a remote server with OAuth authentication
 * @param client The client to connect with
 * @param serverUrl The URL of the remote server
 * @param authProvider The OAuth client provider
 * @param headers Additional headers to send with the request
 * @param authInitializer Function to initialize authentication when needed
 * @param transportStrategy Strategy for selecting transport type ('sse-only', 'http-only', 'sse-first', 'http-first')
 * @param recursionReasons Set of reasons for recursive calls (internal use)
 * @returns The connected transport
 */
export async function connectToRemoteServer(
  client: Client | null,
  serverUrl: string,
  authProvider: OAuthClientProvider,
  headers: Record<string, string>,
  authInitializer: AuthInitializer,
  transportStrategy: TransportStrategy = 'http-first',
  recursionReasons: Set<string> = new Set(),
  protocolMode: ProtocolMode = 'auto',
): Promise<Transport> {
  log(`[${pid}] Connecting to remote server: ${serverUrl}`)
  const url = new URL(serverUrl)

  const resolvedProtocol = await resolveProtocolMode(protocolMode, serverUrl, headers, authProvider)
  log(`Using MCP protocol mode: ${resolvedProtocol}`)

  if (resolvedProtocol === PROTOCOL_2026_07_28) {
    const transport = new StatelessHTTPTransport(url, {
      authProvider,
      requestInit: { headers },
      clientInfo: { name: 'mcp-remote', version: MCP_REMOTE_VERSION },
    })
    let authChallengeTransport: StatelessHTTPTransport | undefined = transport

    try {
      debugLog('Starting stateless HTTP transport (2026-07-28)')
      await transport.start()
      log(`Connected to remote server using StatelessHTTPTransport (${PROTOCOL_2026_07_28})`)
      return transport
    } catch (error: any) {
      if (error instanceof StaleClientRegistrationError) {
        return recoverFromStaleClientRegistration(error, {
          authProvider,
          authInitializer,
          recursionReasons,
          reconnect: () =>
            connectToRemoteServer(
              client,
              serverUrl,
              authProvider,
              headers,
              authInitializer,
              transportStrategy,
              recursionReasons,
              PROTOCOL_2026_07_28,
            ),
        })
      }
      if (isStalePostAuth401Error(error)) {
        return reconnectAfterStaleOAuthAtConnect(error, {
          authProvider,
          transport,
          authChallengeTransport,
          authInitializer,
          serverUrl,
          recursionReasons,
          reconnect: () =>
            connectToRemoteServer(
              client,
              serverUrl,
              authProvider,
              headers,
              authInitializer,
              transportStrategy,
              recursionReasons,
              PROTOCOL_2026_07_28,
            ),
        })
      }
      if (error instanceof UnauthorizedError || (error instanceof Error && error.message.includes('Unauthorized'))) {
        log('Authentication required. Initializing auth...')
        let { waitForAuthCode, skipBrowserAuth, callbackPort: authCallbackPort } = await authInitializer()

        if (!skipBrowserAuth && authCallbackPort > 0) {
          await waitForCallbackServer(authCallbackPort)
        }

        // A concurrent instance completed the browser flow and persisted the tokens. We have no
        // authorization code of our own to exchange (our callback server never received one, and
        // the sibling's code is already redeemed), so run the bounded token-handoff ladder rather
        // than await a code that never arrives (#322/#352).
        if (skipBrowserAuth) {
          const outcome = await handleSecondaryTokenHandoff({
            recursionReasons,
            authInitializer,
            reconnect: () =>
              connectToRemoteServer(
                client,
                serverUrl,
                authProvider,
                headers,
                authInitializer,
                transportStrategy,
                recursionReasons,
                PROTOCOL_2026_07_28,
              ),
          })
          if (outcome.kind === 'connected') return outcome.transport
          // Primary vanished and the coordinator elected us primary: fall through to the normal
          // browser-auth flow using the freshly elected primary's callback.
          waitForAuthCode = outcome.waitForAuthCode
          authCallbackPort = outcome.callbackPort
          if (authCallbackPort > 0) {
            await waitForCallbackServer(authCallbackPort)
          }
        }

        log('Authentication required. Waiting for authorization...')

        const code = await waitForAuthCode()
        try {
          log('Completing authorization...')
          await (authChallengeTransport ?? transport).finishAuth(code)

          if (recursionReasons.has(REASON_AUTH_NEEDED)) {
            throw new Error(`Already attempted reconnection for reason: ${REASON_AUTH_NEEDED}. Giving up.`)
          }
          recursionReasons.add(REASON_AUTH_NEEDED)
          return connectToRemoteServer(
            client,
            serverUrl,
            authProvider,
            headers,
            authInitializer,
            transportStrategy,
            recursionReasons,
            PROTOCOL_2026_07_28,
          )
        } catch (authError: any) {
          log('Authorization error:', authError)
          throw authError
        }
      }
      log('Connection error:', error)
      throw error
    }
  }

  // Create transport with eventSourceInit to pass Authorization header if present
  const eventSourceInit = {
    fetch: (url: string | URL, init?: RequestInit) => {
      return Promise.resolve(authProvider?.tokens?.()).then((tokens) =>
        fetch(url, {
          ...init,
          headers: mergeHeaders(
            init?.headers,
            headers,
            tokens?.access_token ? { Authorization: `Bearer ${tokens.access_token}` } : undefined,
            { Accept: 'text/event-stream' },
          ),
        }),
      )
    },
  }

  log(`Using transport strategy: ${transportStrategy}`)
  // Determine if we should attempt to fallback on error
  // Choose transport based on user strategy and recursion history
  const shouldAttemptFallback = transportStrategy === 'http-first' || transportStrategy === 'sse-first'

  // Create transport instance based on the strategy
  const sseTransport = transportStrategy === 'sse-only' || transportStrategy === 'sse-first'
  const transport = sseTransport
    ? new ReinitAwareSSEClientTransport(url, {
        authProvider,
        requestInit: { headers },
        eventSourceInit,
      })
    : new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: { headers },
        fetch: fetchWithMcpHeaders,
      })

  // In proxy mode the 401 challenge is received by the one-off test transport, not `transport`.
  // finishAuth must run on the transport that stored resource_metadata (#270).
  let authChallengeTransport: SSEClientTransport | StreamableHTTPClientTransport | undefined

  try {
    debugLog('Attempting to connect to remote server', { sseTransport })

    if (client) {
      debugLog('Connecting client to transport')
      await client.connect(transport)
    } else {
      debugLog('Starting transport directly')
      await transport.start()
      if (!sseTransport) {
        // Extremely hacky, but we didn't actually send a request when calling transport.start() above, so we don't
        // know if we're even talking to an HTTP server. But if we forced that now we'd get an error later saying that
        // the client is already connected. So let's just create a one-off client to make a single request and figure
        // out if we're actually talking to an HTTP server or not.
        debugLog('Creating test transport for HTTP-only connection test')
        // This probe sends the very first `initialize` POST, so it is the request a
        // method-aware gateway routes on. It needs the mirrored headers as much as the
        // real transport does (#306).
        const testTransport = new StreamableHTTPClientTransport(url, {
          authProvider,
          requestInit: { headers },
          fetch: fetchWithMcpHeaders,
        })
        authChallengeTransport = testTransport
        const testClient = new Client({ name: 'mcp-remote-fallback-test', version: '0.0.0' }, { capabilities: {} })
        await testClient.connect(testTransport)
      }
    }
    log(`Connected to remote server using ${transport.constructor.name}`)

    return transport
  } catch (error: any) {
    if (error instanceof StaleClientRegistrationError) {
      return recoverFromStaleClientRegistration(error, {
        authProvider,
        authInitializer,
        recursionReasons,
        reconnect: () =>
          connectToRemoteServer(
            client,
            serverUrl,
            authProvider,
            headers,
            authInitializer,
            transportStrategy,
            recursionReasons,
            protocolMode,
          ),
      })
    }
    // Check if it's a protocol error and we should attempt fallback
    // StreamableHTTPError has a `code` property with the HTTP status code
    const isStreamableHTTPError = error instanceof StreamableHTTPError
    const httpStatusCode = isStreamableHTTPError ? error.code : null
    const shouldFallbackOnError =
      shouldAttemptFallback &&
      error instanceof Error &&
      (httpStatusCode === 404 ||
        httpStatusCode === 405 ||
        error.message.includes('405') ||
        error.message.includes('Method Not Allowed') ||
        error.message.includes('404') ||
        error.message.includes('Not Found'))

    if (shouldFallbackOnError) {
      log(`Received error (status ${httpStatusCode ?? 'unknown'}): ${error.message}`)

      // If we've already tried falling back once, throw an error
      if (recursionReasons.has(REASON_TRANSPORT_FALLBACK)) {
        const errorMessage = `Already attempted transport fallback. Giving up.`
        log(errorMessage)
        throw new Error(errorMessage)
      }

      log(`Recursively reconnecting for reason: ${REASON_TRANSPORT_FALLBACK}`)

      // Add to recursion reasons set
      recursionReasons.add(REASON_TRANSPORT_FALLBACK)

      // Recursively call connectToRemoteServer with the updated recursion tracking
      return connectToRemoteServer(
        client,
        serverUrl,
        authProvider,
        headers,
        authInitializer,
        sseTransport ? 'http-only' : 'sse-only',
        recursionReasons,
      )
    } else if (
      error instanceof OAuthError &&
      (error.message?.includes('refresh_token') || error.errorCode === 'invalid_request')
    ) {
      log('Stale OAuth refresh token — clearing cached tokens and reconnecting...')
      if (typeof (authProvider as { invalidateCredentials?: (scope: string) => Promise<void> }).invalidateCredentials === 'function') {
        await authProvider.invalidateCredentials('tokens')
      }
      if (recursionReasons.has(REASON_AUTH_NEEDED)) {
        throw error
      }
      recursionReasons.add(REASON_AUTH_NEEDED)
      return connectToRemoteServer(
        client,
        serverUrl,
        authProvider,
        headers,
        authInitializer,
        transportStrategy,
        recursionReasons,
        protocolMode,
      )
    } else if (isStalePostAuth401Error(error)) {
      return reconnectAfterStaleOAuthAtConnect(error, {
        authProvider,
        transport,
        authChallengeTransport,
        authInitializer,
        serverUrl,
        recursionReasons,
        reconnect: () =>
          connectToRemoteServer(
            client,
            serverUrl,
            authProvider,
            headers,
            authInitializer,
            transportStrategy,
            recursionReasons,
            protocolMode,
          ),
      })
    } else if (error instanceof UnauthorizedError || (error instanceof Error && error.message.includes('Unauthorized'))) {
      log('Authentication required. Initializing auth...')
      debugLog('Authentication error detected', {
        errorCode: error instanceof OAuthError ? error.errorCode : undefined,
        errorMessage: error.message,
        stack: error.stack,
      })

      // Initialize authentication on-demand
      debugLog('Calling authInitializer to start auth flow')
      let { waitForAuthCode, skipBrowserAuth, callbackPort: authCallbackPort } = await authInitializer()

      if (!skipBrowserAuth && authCallbackPort > 0) {
        await waitForCallbackServer(authCallbackPort)
      }

      // A concurrent instance completed the browser flow and persisted the tokens. We have no
      // authorization code of our own to exchange (our callback server never received one, and the
      // sibling's code is already redeemed), so run the bounded token-handoff ladder rather than
      // await a code that never arrives (#322/#352).
      if (skipBrowserAuth) {
        const outcome = await handleSecondaryTokenHandoff({
          recursionReasons,
          authInitializer,
          reconnect: () =>
            connectToRemoteServer(
              client,
              serverUrl,
              authProvider,
              headers,
              authInitializer,
              transportStrategy,
              recursionReasons,
              protocolMode,
            ),
        })
        if (outcome.kind === 'connected') return outcome.transport
        // Primary vanished and the coordinator elected us primary: fall through to the normal
        // browser-auth flow using the freshly elected primary's callback.
        waitForAuthCode = outcome.waitForAuthCode
        authCallbackPort = outcome.callbackPort
        if (authCallbackPort > 0) {
          await waitForCallbackServer(authCallbackPort)
        }
      }

      log('Authentication required. Waiting for authorization...')

      // Wait for the authorization code from the callback
      debugLog('Waiting for auth code from callback server')
      const code = await waitForAuthCode()
      debugLog('Received auth code from callback server')

      try {
        log('Completing authorization...')
        await (authChallengeTransport ?? transport).finishAuth(code)
        debugLog('Authorization completed successfully')

        if (recursionReasons.has(REASON_AUTH_NEEDED)) {
          const errorMessage = `Already attempted reconnection for reason: ${REASON_AUTH_NEEDED}. Giving up.`
          log(errorMessage)
          debugLog('Already attempted auth reconnection, giving up', {
            recursionReasons: Array.from(recursionReasons),
          })
          throw new Error(errorMessage)
        }

        // Track this reason for recursion
        recursionReasons.add(REASON_AUTH_NEEDED)
        log(`Recursively reconnecting for reason: ${REASON_AUTH_NEEDED}`)
        debugLog('Recursively reconnecting after auth', { recursionReasons: Array.from(recursionReasons) })

        // Recursively call connectToRemoteServer with the updated recursion tracking
        return connectToRemoteServer(
          client,
          serverUrl,
          authProvider,
          headers,
          authInitializer,
          transportStrategy,
          recursionReasons,
          protocolMode,
        )
      } catch (authError: any) {
        log('Authorization error:', authError)
        debugLog('Authorization error during finishAuth', {
          errorMessage: authError.message,
          stack: authError.stack,
        })
        throw authError
      }
    } else {
      log('Connection error:', error)
      debugLog('Connection error', {
        errorMessage: error.message,
        stack: error.stack,
        transportType: transport.constructor.name,
      })
      throw error
    }
  }
}

/**
 * Sets up an Express server to handle OAuth callbacks
 * @param options The server options
 * @returns An object with the server, authCode, and waitForAuthCode function
 */
export async function setupOAuthCallbackServerWithLongPoll(options: OAuthCallbackServerOptions) {
  let authCode: string | null = null
  const app = express()

  // Create a promise to track when auth is completed
  let authCompletedResolve: (code: string) => void
  const authCompletedPromise = new Promise<string>((resolve) => {
    authCompletedResolve = resolve
  })

  // Listen for reset-auth-code event to reset authCode to null
  options.events.on('reset-auth-code', () => {
    log('Resetting authCode to null due to new authorization flow')
    debugLog('Received reset-auth-code event, resetting authCode')
    authCode = null
  })

  // Long-polling endpoint
  app.get('/wait-for-auth', (req, res) => {
    if (authCode) {
      // Auth already completed - just return 200 without the actual code
      // Secondary instances will read tokens from disk
      log('Auth already completed, returning 200')
      res.status(200).send('Authentication completed')
      return
    }

    if (req.query.poll === 'false') {
      log('Client requested no long poll, responding with 202')
      res.status(202).send('Authentication in progress')
      return
    }

    // Long poll - wait for up to 30 seconds
    const longPollTimeout = setTimeout(() => {
      log('Long poll timeout reached, responding with 202')
      res.status(202).send('Authentication in progress')
    }, options.authTimeoutMs || 30000)

    // If auth completes while we're waiting, send the response immediately
    authCompletedPromise
      .then(() => {
        clearTimeout(longPollTimeout)
        if (!res.headersSent) {
          log('Auth completed during long poll, responding with 200')
          res.status(200).send('Authentication completed')
        }
      })
      .catch(() => {
        clearTimeout(longPollTimeout)
        if (!res.headersSent) {
          log('Auth failed during long poll, responding with 500')
          res.status(500).send('Authentication failed')
        }
      })
  })

  // OAuth callback endpoint
  app.get(options.path, (req, res) => {
    const code = req.query.code as string | undefined
    if (!code) {
      res.status(400).send('Error: No authorization code received')
      return
    }

    authCode = code
    log('Auth code received, resolving promise')
    authCompletedResolve(code)

    res.send(`
      Authorization successful!
      You may close this window and return to the CLI.
      <script>
        // If this is a non-interactive session (no manual approval step was required) then
        // this should automatically close the window. If not, this will have no effect and
        // the user will see the message above.
        window.close();
      </script>
    `)

    // Notify main flow that auth code is available
    options.events.emit('auth-code-received', code)
  })

  const { server, port } = await bindExpressServer(app, options.port, options.allowPortFallback !== false)

  const waitForAuthCode = (): Promise<string> => {
    return new Promise((resolve) => {
      if (authCode) {
        resolve(authCode)
        authCode = null 
        return
      }

      options.events.once('auth-code-received', (code) => {
        resolve(code)
        authCode = null 
      })
    })
  }

  return { server, authCode, waitForAuthCode, authCompletedPromise, port }
}

/**
 * Sets up an Express server to handle OAuth callbacks
 * @param options The server options
 * @returns An object with the server, authCode, and waitForAuthCode function
 */
export async function setupOAuthCallbackServer(options: OAuthCallbackServerOptions) {
  const { server, authCode, waitForAuthCode, port } = await setupOAuthCallbackServerWithLongPoll(options)
  return { server, authCode, waitForAuthCode, port }
}

export async function findExistingClientPort(serverUrlHash: string): Promise<number | undefined> {
  const clientInfo = await readJsonFile<OAuthClientInformationFull>(serverUrlHash, 'client_info.json', OAuthClientInformationFullSchema)
  if (!clientInfo) {
    return undefined
  }

  const localhostRedirectUri = clientInfo.redirect_uris
    .map((uri) => new URL(uri))
    .find(({ hostname }) => hostname === 'localhost' || hostname === '127.0.0.1')
  if (!localhostRedirectUri) {
    throw new Error('Cannot find localhost callback URI from existing client information')
  }

  return parseInt(localhostRedirectUri.port)
}

function calculateDefaultPort(serverUrlHash: string): number {
  let hash = 0
  for (let i = 0; i < serverUrlHash.length; i++) {
    hash = (hash * 31 + serverUrlHash.charCodeAt(i)) >>> 0
  }
  return 3335 + (hash % 45816)
}

/**
 * Deterministic fallback callback port for a given attempt, used when the canonical callback
 * port is occupied by an unrelated process. Because the sequence is derived only from the
 * server hash, all concurrent instances compute the same candidate ports — so the exclusive
 * port bind still elects exactly one primary even during fallback (prevents two primaries when
 * a foreign process squats on the canonical port).
 */
export function calculateFallbackPort(serverUrlHash: string, attempt: number): number {
  return calculateDefaultPort(`${serverUrlHash}:fallback:${attempt}`)
}

async function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

export async function invalidateOAuthClientRegistration(serverUrlHash: string, reason: string): Promise<void> {
  try {
    await rm(getConfigFilePath(serverUrlHash, 'client_info.json'))
    log(`Cleared cached OAuth client registration (${reason})`)
  } catch {
    // no cached registration
  }
}

async function resolveCallbackPort(serverUrlHash: string, specifiedPort?: number): Promise<number> {
  // Resolve the *deterministic* canonical callback port. We intentionally do NOT probe/drift
  // here: concurrent instances must all target the same port so that coordinateAuth can use an
  // exclusive bind of that port as the cross-process election mutex. Genuine port conflicts
  // (an unrelated process holding the port) are handled by coordinateAuth's fallback path.
  const defaultPort = calculateDefaultPort(serverUrlHash)
  const existingClientPort = await findExistingClientPort(serverUrlHash)

  if (specifiedPort) {
    if (existingClientPort && specifiedPort !== existingClientPort) {
      await invalidateOAuthClientRegistration(
        serverUrlHash,
        `callback port changed from ${existingClientPort} to ${specifiedPort}`,
      )
    }
    return specifiedPort
  }

  if (existingClientPort) {
    return existingClientPort
  }

  return defaultPort
}

async function bindExpressServer(
  app: express.Application,
  preferredPort: number,
  allowFallback = true,
): Promise<{ server: Server; port: number }> {
  let port = preferredPort

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const server = await new Promise<Server>((resolve, reject) => {
        const listener = app.listen(port, '127.0.0.1')
        listener.once('listening', () => resolve(listener))
        listener.once('error', reject)
      })

      if (port !== preferredPort) {
        log(`OAuth callback port ${preferredPort} was in use — listening on ${port} instead`)
      } else {
        log(`OAuth callback server running at http://127.0.0.1:${port}`)
      }

      return { server, port }

    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        // When used as an election mutex the caller must observe EADDRINUSE (to become a
        // secondary) instead of silently drifting to another port.
        if (!allowFallback) {
          throw error
        }
        port = await findAvailablePort(0)
        continue
      }
      throw error
    }
  }

  throw new Error('Failed to bind OAuth callback server after multiple attempts')
}

/**
 * Finds an available port on the local machine
 * @param preferredPort Optional preferred port to try first
 * @returns A promise that resolves to an available port number
 */
export async function findAvailablePort(preferredPort?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // If preferred port is in use, get a random port
        server.listen(0)
      } else {
        reject(err)
      }
    })

    server.on('listening', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => {
        resolve(port)
      })
    })

    // Try preferred port first, or get a random port
    server.listen(preferredPort || 0)
  })
}

/**
 * Returns positional CLI args after removing known flags and their values.
 */
export function getPositionalArgs(args: string[]): string[] {
  const booleanFlags = new Set(['--allow-http', '--debug', '--silent', '--enable-proxy'])
  const valueFlags = new Set([
    '--protocol',
    '--transport',
    '--host',
    '--header',
    '--static-oauth-client-metadata',
    '--static-oauth-client-info',
    '--resource',
    '--ignore-tool',
    '--auth-timeout',
  ])

  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (booleanFlags.has(arg)) {
      continue
    }
    if (valueFlags.has(arg)) {
      i++
      continue
    }
    if (arg.startsWith('-')) {
      continue
    }
    positional.push(arg)
  }
  return positional
}

/**
 * Parses command line arguments for MCP clients and proxies
 * @param args Command line arguments
 * @param usage Usage message to show on error
 * @returns A promise that resolves to an object with parsed serverUrl, callbackPort and headers
 */
export async function parseCommandLineArgs(args: string[], usage: string) {
  // Process headers
  const headers: Record<string, string> = {}
  let i = 0
  while (i < args.length) {
    if (args[i] === '--header' && i < args.length - 1) {
      const value = args[i + 1]
      const match = value.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
      if (match) {
        headers[match[1]] = match[2]
      } else {
        log(`Warning: ignoring invalid header argument: ${value}`)
      }
      args.splice(i, 2)
      // Do not increment i, as the array has shifted
      continue
    }
    i++
  }

  const allowHttp = args.includes('--allow-http')

  // Check for debug flag
  const debug = args.includes('--debug')
  if (debug) {
    DEBUG = true
    log('Debug mode enabled - detailed logs will be written to ~/.mcp-auth/')
  }

  // Check for silent flag
  const silent = args.includes('--silent')
  if (silent) {
    SILENT = true
    log('Silent mode enabled - stderr output will be suppressed, except when --debug is also enabled')
  }

  const enableProxy = args.includes('--enable-proxy')
  if (enableProxy) {
    // Use env proxy
    setGlobalDispatcher(new EnvHttpProxyAgent())
    log('HTTP proxy support enabled - using system HTTP_PROXY/HTTPS_PROXY environment variables')
  }

  // Parse protocol mode (legacy | auto | 2026-07-28)
  let protocolMode: ProtocolMode = 'auto'
  const protocolIndex = args.indexOf('--protocol')
  if (protocolIndex !== -1 && protocolIndex < args.length - 1) {
    const mode = args[protocolIndex + 1]
    if (mode === 'legacy' || mode === 'auto' || mode === PROTOCOL_2026_07_28) {
      protocolMode = mode
      log(`Using MCP protocol mode: ${protocolMode}`)
    } else {
      log(`Warning: Ignoring invalid --protocol value: ${mode}. Use auto, legacy, or ${PROTOCOL_2026_07_28}`)
    }
  }

  // Parse transport strategy
  let transportStrategy: TransportStrategy = 'http-first' // Default
  const transportIndex = args.indexOf('--transport')
  if (transportIndex !== -1 && transportIndex < args.length - 1) {
    const strategy = args[transportIndex + 1]
    if (strategy === 'sse-only' || strategy === 'http-only' || strategy === 'sse-first' || strategy === 'http-first') {
      transportStrategy = strategy as TransportStrategy
      log(`Using transport strategy: ${transportStrategy}`)
    } else {
      log(`Warning: Ignoring invalid transport strategy: ${strategy}. Valid values are: sse-only, http-only, sse-first, http-first`)
    }
  }

  // Parse host
  let host = 'localhost' // Default
  const hostIndex = args.indexOf('--host')
  if (hostIndex !== -1 && hostIndex < args.length - 1) {
    host = args[hostIndex + 1]
    log(`Using callback hostname: ${host}`)
  }

  let staticOAuthClientMetadata: StaticOAuthClientMetadata = null
  const staticOAuthClientMetadataIndex = args.indexOf('--static-oauth-client-metadata')
  if (staticOAuthClientMetadataIndex !== -1 && staticOAuthClientMetadataIndex < args.length - 1) {
    const staticOAuthClientMetadataArg = args[staticOAuthClientMetadataIndex + 1]
    if (staticOAuthClientMetadataArg.startsWith('@')) {
      const filePath = staticOAuthClientMetadataArg.slice(1)
      staticOAuthClientMetadata = JSON.parse(await readFile(filePath, 'utf8'))
      log(`Using static OAuth client metadata from file: ${filePath}`)
    } else {
      staticOAuthClientMetadata = JSON.parse(staticOAuthClientMetadataArg)
      log(`Using static OAuth client metadata from string`)
    }
  }

  // parse static OAuth client information, if provided
  // defaults to OAuth dynamic client registration
  let staticOAuthClientInfo: StaticOAuthClientInformationFull = null
  const staticOAuthClientInfoIndex = args.indexOf('--static-oauth-client-info')
  if (staticOAuthClientInfoIndex !== -1 && staticOAuthClientInfoIndex < args.length - 1) {
    const staticOAuthClientInfoArg = args[staticOAuthClientInfoIndex + 1]
    if (staticOAuthClientInfoArg.startsWith('@')) {
      const filePath = staticOAuthClientInfoArg.slice(1)
      staticOAuthClientInfo = JSON.parse(await readFile(filePath, 'utf8'))
      log(`Using static OAuth client information from file: ${filePath}`)
    } else {
      staticOAuthClientInfo = JSON.parse(staticOAuthClientInfoArg)
      log(`Using static OAuth client information from string`)
    }
  }

  // Parse resource to authorize
  let authorizeResource = '' // Default
  const resourceIndex = args.indexOf('--resource')
  if (resourceIndex !== -1 && resourceIndex < args.length - 1) {
    authorizeResource = args[resourceIndex + 1]
    log(`Using authorize resource: ${authorizeResource}`)
  }

  // Parse ignored tools
  const ignoredTools: string[] = []
  let j = 0
  while (j < args.length) {
    if (args[j] === '--ignore-tool' && j < args.length - 1) {
      const toolName = args[j + 1]
      ignoredTools.push(toolName)
      log(`Ignoring tool: ${toolName}`)
      args.splice(j, 2)
      // Do not increment j, as the array has shifted
      continue
    }
    j++
  }

  // Parse auth timeout
  let authTimeoutMs = 30000 // Default 30 seconds
  const authTimeoutIndex = args.indexOf('--auth-timeout')
  if (authTimeoutIndex !== -1 && authTimeoutIndex < args.length - 1) {
    const timeoutSeconds = parseInt(args[authTimeoutIndex + 1], 10)
    if (!isNaN(timeoutSeconds) && timeoutSeconds > 0) {
      authTimeoutMs = timeoutSeconds * 1000
      log(`Using auth callback timeout: ${timeoutSeconds} seconds`)
    } else {
      log(`Warning: Ignoring invalid auth timeout value: ${args[authTimeoutIndex + 1]}. Must be a positive number.`)
    }
  }

  const positional = getPositionalArgs(args)
  const serverUrl = positional[0]
  const specifiedPort = positional[1] ? parseInt(positional[1], 10) : undefined

  if (!serverUrl) {
    log(usage)
    process.exit(1)
  }

  const url = new URL(serverUrl)
  const isLocalhost = (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:'

  if (!(url.protocol == 'https:' || isLocalhost || allowHttp)) {
    log('Error: Non-HTTPS URLs are only allowed for localhost or when --allow-http flag is provided')
    log(usage)
    process.exit(1)
  }
  // Calculate hash with all parsed parameters for cache isolation
  const serverUrlHash = getServerUrlHash(serverUrl, authorizeResource, headers)

  // Set server hash globally for debug logging
  global.currentServerUrlHash = serverUrlHash

  debugLog(`Starting mcp-remote with server URL: ${serverUrl}`)

  const callbackPort = await resolveCallbackPort(serverUrlHash, specifiedPort)
  if (specifiedPort) {
    log(`Using specified callback port: ${callbackPort}`)
  } else {
    log(`Using automatically selected callback port: ${callbackPort}`)
  }

  if (Object.keys(headers).length > 0) {
    log(`Using custom header names: ${Object.keys(headers).join(', ')}`)
  }
  // Replace environment variables in headers
  // example `Authorization: Bearer ${TOKEN}` will read process.env.TOKEN
  for (const [key, value] of Object.entries(headers)) {
    headers[key] = value.replace(/\$\{([^}]+)}/g, (match, envVarName) => {
      const envVarValue = process.env[envVarName]

      if (envVarValue !== undefined) {
        log(`Replacing ${match} with environment value in header '${key}'`)
        return envVarValue
      } else {
        log(`Warning: Environment variable '${envVarName}' not found for header '${key}'.`)
        return ''
      }
    })
  }

  return {
    serverUrl,
    callbackPort,
    headers,
    transportStrategy,
    host,
    debug,
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    ignoredTools,
    authTimeoutMs,
    serverUrlHash,
    protocolMode,
  }
}

/**
 * Sets up signal handlers for graceful shutdown
 * @param cleanup Cleanup function to run on shutdown
 */
export function setupSignalHandlers(cleanup: () => Promise<void>) {
  process.on('SIGINT', async () => {
    log('\nShutting down...')
    await cleanup()
    process.exit(0)
  })

  // Keep the process alive
  process.stdin.resume()
  process.stdin.on('end', async () => {
    log('\nShutting down...')
    await cleanup()
    process.exit(0)
  })
}

/**
 * Generates a hash for the server URL configuration
 * Includes resource and headers to isolate OAuth sessions per unique
 * server configuration (fixes #25: multi-instance support)
 * @param serverUrl The server URL
 * @param authorizeResource Optional resource parameter for OAuth
 * @param headers Optional custom headers
 * @returns MD5 hash of the configuration
 */
export function getServerUrlHash(serverUrl: string, authorizeResource?: string, headers?: Record<string, string>): string {
  // Include resource and headers in hash to isolate OAuth sessions
  // per unique server configuration (fixes #25)
  const parts = [serverUrl]
  if (authorizeResource) parts.push(authorizeResource)
  if (headers && Object.keys(headers).length > 0) {
    const sortedKeys = Object.keys(headers).sort()
    parts.push(JSON.stringify(headers, sortedKeys))
  }
  return crypto.createHash('md5').update(parts.join('|')).digest('hex')
}

/**
 * Converts a glob pattern to a regular expression
 * @param pattern The glob pattern (e.g., "create*", "*account")
 * @returns The corresponding regular expression
 */
function patternToRegex(pattern: string): RegExp {
  // Split by asterisks, escape each part, then join with .*
  const parts = pattern.split('*')
  const escapedParts = parts.map((part) => part.replace(/\W/g, '\\$&'))
  const regexPattern = escapedParts.join('.*')
  // Match the entire string from start to end, case-insensitive
  return new RegExp(`^${regexPattern}$`, 'i')
}

/**
 * Determines if a tool name should be ignored based on ignore patterns
 * @param ignorePatterns Array of patterns to ignore (supports wildcards with *)
 * @param toolName The name of the tool to check
 * @returns false if the tool should be ignored (matches a pattern), true if it should be included
 */
export function shouldIncludeTool(ignorePatterns: string[], toolName: string): boolean {
  // If no patterns are provided, include all tools
  if (!ignorePatterns || ignorePatterns.length === 0) {
    return true
  }

  // Check if the tool name matches any ignore pattern
  for (const pattern of ignorePatterns) {
    const regex = patternToRegex(pattern)
    if (regex.test(toolName)) {
      return false // Tool matches an ignore pattern, so exclude it
    }
  }

  return true // Tool doesn't match any ignore pattern, so include it
}

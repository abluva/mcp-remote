/**
 * MCP 2026-07-28 stateless protocol helpers.
 *
 * Used by StatelessHTTPTransport (remote leg) and mcpProxy (stdio bridge shims).
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export const PROTOCOL_2026_07_28 = '2026-07-28' as const

export type ProtocolMode = 'auto' | 'legacy' | typeof PROTOCOL_2026_07_28

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

export const UNSUPPORTED_PROTOCOL_VERSION = -32022

export type DiscoverResult = {
  protocolVersion?: string
  supportedProtocolVersions?: string[]
  capabilities?: Record<string, unknown>
  serverInfo?: { name: string; version: string }
}

export type ClientMetaContext = {
  protocolVersion: string
  clientInfo: { name: string; version: string }
  clientCapabilities: Record<string, unknown>
}

export function parseProtocolMode(value: string | undefined): ProtocolMode {
  if (value === 'legacy' || value === PROTOCOL_2026_07_28 || value === 'auto') {
    return value
  }
  return 'auto'
}

export function injectRequestMeta(message: JSONRPCMessage, ctx: ClientMetaContext): JSONRPCMessage {
  const meta = {
    [META_PROTOCOL_VERSION]: ctx.protocolVersion,
    [META_CLIENT_CAPABILITIES]: ctx.clientCapabilities,
    [META_CLIENT_INFO]: ctx.clientInfo,
  }

  if (!('method' in message) || !message.method) {
    return message
  }

  const params =
    message.params && typeof message.params === 'object' && !Array.isArray(message.params)
      ? { ...(message.params as Record<string, unknown>) }
      : {}

  const existingMeta =
    params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : {}

  params._meta = { ...existingMeta, ...meta }

  return { ...message, params }
}

export function buildSyntheticInitializeResult(
  discover: DiscoverResult,
  requestedVersion?: string,
  options?: { shimForLocalClient?: boolean },
): {
  protocolVersion: string
  capabilities: Record<string, unknown>
  serverInfo: { name: string; version: string }
} {
  // When adapting stateless remote → stateful stdio client (Claude), echo the
  // client's requested protocol version. The remote v2 wire format is internal.
  if (options?.shimForLocalClient && requestedVersion) {
    return {
      protocolVersion: requestedVersion,
      capabilities: discover.capabilities ?? { tools: {} },
      serverInfo: discover.serverInfo ?? { name: 'remote-mcp-server', version: '0.0.0' },
    }
  }

  const supported = discover.supportedProtocolVersions ?? [PROTOCOL_2026_07_28]
  const protocolVersion =
    requestedVersion && supported.includes(requestedVersion)
      ? requestedVersion
      : discover.protocolVersion ?? PROTOCOL_2026_07_28

  return {
    protocolVersion,
    capabilities: discover.capabilities ?? { tools: {} },
    serverInfo: discover.serverInfo ?? { name: 'remote-mcp-server', version: '0.0.0' },
  }
}

export function stripStatelessWireMeta<T extends Record<string, unknown>>(result: T): Omit<T, '_meta'> {
  if (!result || typeof result !== 'object') {
    return result
  }
  const { _meta: _ignored, ...rest } = result
  return rest as Omit<T, '_meta'>
}

/**
 * Normalize tools/call results before forwarding to stdio clients (Claude Desktop).
 *
 * Some upstream servers (Atlassian MCP) return `structuredContent` as an array, but
 * CallToolResultSchema requires an object — strict clients accept the JSON-RPC frame
 * in logs yet drop the tool result from the conversation when validation fails.
 */
export function sanitizeCallToolResultForStdioClient<T extends Record<string, unknown>>(
  result: T,
  options?: { stripWireMeta?: boolean },
): T {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result
  }

  let next: Record<string, unknown> = options?.stripWireMeta
    ? { ...stripStatelessWireMeta(result) }
    : { ...result }

  if (Array.isArray(next.structuredContent)) {
    const { structuredContent: _removed, ...rest } = next
    next = rest
  }

  const meta = next._meta
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const metaCopy = { ...(meta as Record<string, unknown>) }
    if ('_abluva' in metaCopy) {
      delete metaCopy._abluva
      if (Object.keys(metaCopy).length === 0) {
        const { _meta: _removed, ...rest } = next
        next = rest
      } else {
        next = { ...next, _meta: metaCopy }
      }
    }
  }

  return next as T
}

export function isNonFatalSseDisconnect(error: Error, pendingRequestCount: number): boolean {
  const msg = error.message ?? ''
  return pendingRequestCount === 0 && msg.includes('SSE stream disconnected')
}

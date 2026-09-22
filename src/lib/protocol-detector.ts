import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { fetch } from 'undici'
import { MCP_REMOTE_VERSION } from './utils.js'
import { injectRequestMeta, PROTOCOL_2026_07_28, type ProtocolMode } from './stateless-protocol.js'

/**
 * Probe whether the remote server supports MCP 2026-07-28 via server/discover.
 */
export async function detectRemoteProtocolMode(
  serverUrl: string,
  headers: Record<string, string>,
  authProvider?: OAuthClientProvider,
): Promise<'2026-07-28' | 'legacy'> {
  try {
    const url = new URL(serverUrl)
    const tokens = await authProvider?.tokens?.()
    const msg = injectRequestMeta(
      { jsonrpc: '2.0', id: 0, method: 'server/discover', params: {} },
      {
        protocolVersion: PROTOCOL_2026_07_28,
        clientInfo: { name: 'mcp-remote-probe', version: MCP_REMOTE_VERSION },
        clientCapabilities: { tools: {} },
      },
    )

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': PROTOCOL_2026_07_28,
        ...(tokens?.access_token ? { Authorization: `Bearer ${tokens.access_token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      return 'legacy'
    }

    const body = (await res.json()) as {
      result?: { protocolVersion?: string; supportedProtocolVersions?: string[] }
    }

    if (body.result?.protocolVersion === PROTOCOL_2026_07_28) {
      return PROTOCOL_2026_07_28
    }
    if (body.result?.supportedProtocolVersions?.includes(PROTOCOL_2026_07_28)) {
      return PROTOCOL_2026_07_28
    }
  } catch {
    // fall through to legacy
  }

  return 'legacy'
}

export async function resolveProtocolMode(
  mode: ProtocolMode,
  serverUrl: string,
  headers: Record<string, string>,
  authProvider?: OAuthClientProvider,
): Promise<'2026-07-28' | 'legacy'> {
  if (mode === 'legacy') return 'legacy'
  if (mode === PROTOCOL_2026_07_28) return PROTOCOL_2026_07_28
  return detectRemoteProtocolMode(serverUrl, headers, authProvider)
}

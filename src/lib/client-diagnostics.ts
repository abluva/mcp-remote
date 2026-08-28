import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js'
import { log } from './utils'

/**
 * Options for {@link attachClientDiagnostics}.
 */
export interface ClientDiagnosticsOptions {
  /**
   * Invoked after logging when the connection closes. Defaults to `process.exit(0)`,
   * preserving the historical CLI behaviour. Overridable for tests so the process
   * is not torn down.
   */
  onClose?: () => void
}

/**
 * Attaches non-invasive diagnostic logging to an already-connected MCP {@link Client}.
 *
 * Background (issue #324): `Client.connect(transport)` installs the SDK's own
 * response dispatcher on `transport.onmessage` — this is what settles the promises
 * returned by `client.request(...)`. Previously the client entry point replaced
 * `transport.onmessage` with a logging-only handler *after* connecting, which
 * silently discarded every dispatched response and caused `tools/list` /
 * `resources/list` to hang until the 60s SDK timeout fired with error -32001.
 *
 * This helper instead:
 *  - preserves the existing `transport.onmessage` dispatcher and chains our
 *    "Received message" logging in front of it, and
 *  - routes error/close diagnostics through `client.onerror` / `client.onclose`
 *    (public Protocol callbacks) rather than clobbering `transport.onerror` /
 *    `transport.onclose`, which the Protocol also owns.
 *
 * @param client The connected client whose transport already has the SDK dispatcher installed.
 * @param transport The transport returned from `connectToRemoteServer` (post-connect).
 * @param options Optional overrides (see {@link ClientDiagnosticsOptions}).
 */
export function attachClientDiagnostics(client: Client, transport: Transport, options: ClientDiagnosticsOptions = {}): void {
  // Capture the dispatcher that Client.connect() installed. Chaining in front of
  // it keeps request/response settling intact while still logging every message.
  const sdkDispatch = transport.onmessage

  transport.onmessage = <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
    log('Received message:', JSON.stringify(message, null, 2))
    sdkDispatch?.(message, extra)
  }

  // Use the Protocol-level callbacks so we don't displace the transport-level
  // handlers the SDK relies on for close/error propagation.
  client.onerror = (error) => {
    log('Transport error:', error)
  }

  client.onclose = () => {
    log('Connection closed.')
    if (options.onClose) {
      options.onClose()
    } else {
      process.exit(0)
    }
  }
}

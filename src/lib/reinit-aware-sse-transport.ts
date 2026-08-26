import { SSEClientTransport, type SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import { debugLog, log } from './utils'

/**
 * Thin subclass of the SDK's `SSEClientTransport` that detects when the underlying
 * `EventSource` reconnects to a *new* MCP session (issue #269).
 *
 * Background (SDK 1.30.0, verified against node_modules):
 *  - `SSEClientTransport` receives the POST endpoint via an `endpoint` SSE event and stores it
 *    in the private `_endpoint` field. On EventSource reconnect the same event re-fires and the
 *    SDK silently overwrites `_endpoint` — but it never replays `initialize`, so a server that
 *    mints a fresh session per SSE connection rejects every subsequent request.
 *  - The SDK exposes no public getter/event for the endpoint, so we attach our own listener to
 *    the internal `_eventSource` after `start()`. The SDK's own `endpoint` listener is registered
 *    first (during `super.start()`), so by the time ours runs `_endpoint` already holds the new
 *    value and we simply read it.
 *
 * Detection rules:
 *  - first `endpoint`  -> record baseline only (no signal)
 *  - same endpoint     -> no signal
 *  - changed endpoint  -> invoke `onSessionRotated`
 *
 * All private-field access is confined to this file and guarded, so a future SDK that renames or
 * removes these fields degrades gracefully to the current (pre-#269) behaviour instead of throwing.
 */
export class ReinitAwareSSEClientTransport extends SSEClientTransport {
  /** Invoked when a reconnect established a *different* endpoint/session than before. */
  onSessionRotated?: () => void

  private _lastEndpointHref: string | undefined
  private _rotationListenerAttached = false

  constructor(url: URL, opts?: SSEClientTransportOptions) {
    super(url, opts)
  }

  async start(): Promise<void> {
    await super.start()
    this.attachRotationListener()
  }

  /** Reads the SDK's private `_endpoint` (a URL) if present. */
  private currentEndpointHref(): string | undefined {
    const endpoint = (this as unknown as { _endpoint?: URL })._endpoint
    return endpoint ? endpoint.href : undefined
  }

  private attachRotationListener(): void {
    if (this._rotationListenerAttached) return

    const eventSource = (this as unknown as { _eventSource?: EventTarget & { addEventListener?: unknown } })._eventSource
    if (!eventSource || typeof eventSource.addEventListener !== 'function') {
      debugLog('ReinitAwareSSEClientTransport: EventSource not accessible; rotation detection disabled')
      return
    }

    // Baseline is the endpoint captured by the SDK during the first successful connection.
    this._lastEndpointHref = this.currentEndpointHref()
    this._rotationListenerAttached = true

    // Our listener runs after the SDK's own `endpoint` listener (registered earlier), so
    // `_endpoint` is already updated to the new value when we read it here.
    ;(eventSource as EventTarget).addEventListener('endpoint', () => this.handleEndpointEvent())
  }

  private handleEndpointEvent(): void {
    const current = this.currentEndpointHref()
    if (!current) return

    if (this._lastEndpointHref === undefined) {
      // First endpoint we ever saw (listener attached before start resolved): baseline only.
      this._lastEndpointHref = current
      return
    }

    if (current === this._lastEndpointHref) {
      // Reconnect to the same session — nothing to recover.
      return
    }

    this._lastEndpointHref = current
    log('SSE endpoint/session rotated after reconnect; requesting re-initialize (issue #269)')
    debugLog('SSE endpoint rotated', { endpoint: current })
    try {
      this.onSessionRotated?.()
    } catch (error) {
      debugLog('onSessionRotated handler threw', { error })
    }
  }
}

/** Type guard used by `mcpProxy` to wire session-rotation recovery only for the SSE transport. */
export function isReinitAwareSSETransport(transport: unknown): transport is ReinitAwareSSEClientTransport {
  return transport instanceof ReinitAwareSSEClientTransport
}

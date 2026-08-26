import { describe, it, expect, vi } from 'vitest'
import { ReinitAwareSSEClientTransport, isReinitAwareSSETransport } from './reinit-aware-sse-transport'

/**
 * Unit tests for the SSE endpoint/session rotation detector (issue #269).
 *
 * These exercise the detection logic in isolation by faking the SDK's internal `_eventSource`
 * (an EventTarget) and `_endpoint` (a URL), then invoking the private `attachRotationListener`
 * and dispatching `endpoint` events — no real network connection is made.
 */
describe('Feature: ReinitAwareSSEClientTransport rotation detection', () => {
  function makeTransport() {
    const t = new ReinitAwareSSEClientTransport(new URL('http://localhost/sse'))
    const eventSource = new EventTarget()
    ;(t as any)._eventSource = eventSource
    return { t, eventSource }
  }

  function setEndpoint(t: ReinitAwareSSEClientTransport, href: string) {
    ;(t as any)._endpoint = new URL(href)
  }

  it('Scenario: Initial endpoint records a baseline and does not trigger reinit', () => {
    // Given a transport whose first endpoint has been received
    const { t } = makeTransport()
    setEndpoint(t, 'http://localhost/messages?sessionId=A')
    const onRotated = vi.fn()
    t.onSessionRotated = onRotated

    // When the rotation listener attaches (baseline capture)
    ;(t as any).attachRotationListener()

    // Then no rotation is signalled
    expect(onRotated).not.toHaveBeenCalled()
  })

  it('Scenario: Reconnect to the same endpoint does not trigger reinit', () => {
    // Given a baseline endpoint A
    const { t, eventSource } = makeTransport()
    setEndpoint(t, 'http://localhost/messages?sessionId=A')
    const onRotated = vi.fn()
    t.onSessionRotated = onRotated
    ;(t as any).attachRotationListener()

    // When the EventSource reconnects and re-delivers the same endpoint A
    setEndpoint(t, 'http://localhost/messages?sessionId=A')
    eventSource.dispatchEvent(new Event('endpoint'))

    // Then no rotation is signalled
    expect(onRotated).not.toHaveBeenCalled()
  })

  it('Scenario: Reconnect to a different endpoint triggers exactly one reinit', () => {
    // Given a baseline endpoint A
    const { t, eventSource } = makeTransport()
    setEndpoint(t, 'http://localhost/messages?sessionId=A')
    const onRotated = vi.fn()
    t.onSessionRotated = onRotated
    ;(t as any).attachRotationListener()

    // When the EventSource reconnects onto a new session B
    setEndpoint(t, 'http://localhost/messages?sessionId=B')
    eventSource.dispatchEvent(new Event('endpoint'))

    // Then rotation is signalled exactly once
    expect(onRotated).toHaveBeenCalledTimes(1)

    // And the new endpoint becomes the baseline (re-delivery of B does not re-trigger)
    eventSource.dispatchEvent(new Event('endpoint'))
    expect(onRotated).toHaveBeenCalledTimes(1)
  })

  it('Scenario: Missing internal EventSource disables detection without throwing', () => {
    // Given a transport where the SDK internals are not accessible
    const t = new ReinitAwareSSEClientTransport(new URL('http://localhost/sse'))
    ;(t as any)._eventSource = undefined
    const onRotated = vi.fn()
    t.onSessionRotated = onRotated

    // When attaching the listener
    // Then it neither throws nor signals rotation
    expect(() => (t as any).attachRotationListener()).not.toThrow()
    expect(onRotated).not.toHaveBeenCalled()
  })

  it('Scenario: Type guard recognises the subclass', () => {
    const t = new ReinitAwareSSEClientTransport(new URL('http://localhost/sse'))
    expect(isReinitAwareSSETransport(t)).toBe(true)
    expect(isReinitAwareSSETransport({})).toBe(false)
    expect(isReinitAwareSSETransport(undefined)).toBe(false)
  })
})

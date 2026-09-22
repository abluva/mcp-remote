import { describe, it, expect } from 'vitest'
import { SecondaryHandoffExhaustedError, isBenignSecondaryExit } from './secondary-handoff-exhausted-error'

/**
 * Unit tests for the benign secondary-exit classifier (#352).
 *
 * The proxy uses this pure predicate to decide whether an exhausted secondary should exit quietly
 * (0) or fail fatally (1). The rule must be strict: benign ONLY when the error is a
 * SecondaryHandoffExhaustedError, OAuth coordination was in play, AND a live primary is confirmed.
 * Anything else must remain fatal so a genuine failure is never silently hidden.
 */
describe('isBenignSecondaryExit (#352)', () => {
  const exhausted = new SecondaryHandoffExhaustedError()

  it('is benign when a live primary is confirmed and OAuth coordination was in play', () => {
    expect(isBenignSecondaryExit(exhausted, { skipOAuthSetup: false, primaryAlive: true })).toBe(true)
  })

  it('is fatal when no live primary can be confirmed', () => {
    // The exhausted secondary could not reach a working connection and there is no sibling serving
    // the server — this must surface as a genuine failure, not a quiet exit.
    expect(isBenignSecondaryExit(exhausted, { skipOAuthSetup: false, primaryAlive: false })).toBe(false)
  })

  it('is fatal when OAuth setup was skipped (no coordination / no sibling to defer to)', () => {
    // A local no-auth server never elects a primary, so a live-primary probe is meaningless here.
    expect(isBenignSecondaryExit(exhausted, { skipOAuthSetup: true, primaryAlive: true })).toBe(false)
    expect(isBenignSecondaryExit(exhausted, { skipOAuthSetup: true, primaryAlive: false })).toBe(false)
  })

  it('is fatal for any other error type, even with a live primary', () => {
    expect(isBenignSecondaryExit(new Error('Unauthorized'), { skipOAuthSetup: false, primaryAlive: true })).toBe(false)
    expect(isBenignSecondaryExit(new TypeError('boom'), { skipOAuthSetup: false, primaryAlive: true })).toBe(false)
  })

  it('is fatal for non-error values (never throws, never hides a real problem)', () => {
    expect(isBenignSecondaryExit(undefined, { skipOAuthSetup: false, primaryAlive: true })).toBe(false)
    expect(isBenignSecondaryExit(null, { skipOAuthSetup: false, primaryAlive: true })).toBe(false)
    expect(isBenignSecondaryExit('SecondaryHandoffExhaustedError', { skipOAuthSetup: false, primaryAlive: true })).toBe(false)
  })

  it('requires both coordination and a live primary together (matrix)', () => {
    const matrix: Array<{ skipOAuthSetup: boolean; primaryAlive: boolean; expected: boolean }> = [
      { skipOAuthSetup: false, primaryAlive: true, expected: true },
      { skipOAuthSetup: false, primaryAlive: false, expected: false },
      { skipOAuthSetup: true, primaryAlive: true, expected: false },
      { skipOAuthSetup: true, primaryAlive: false, expected: false },
    ]
    for (const { skipOAuthSetup, primaryAlive, expected } of matrix) {
      expect(isBenignSecondaryExit(exhausted, { skipOAuthSetup, primaryAlive })).toBe(expected)
    }
  })
})

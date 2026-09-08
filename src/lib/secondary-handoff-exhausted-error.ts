/**
 * Thrown by a SECONDARY instance when the cross-process token handoff (#17/#322) cannot yield a
 * working connection: the primary's handed-over tokens were rejected, the one bounded coordinated
 * recovery attempt did not succeed, and the primary still owns the callback port (so this instance
 * must not run its own browser flow).
 *
 * This is a *benign* terminal condition, not a crash: when a live primary is confirmed the proxy
 * exits quietly (0) so the MCP host does not surface a false "Server disconnected" for a server the
 * primary is serving normally (#352). If no live primary can be confirmed, callers should treat it
 * as a genuine failure instead.
 */
export class SecondaryHandoffExhaustedError extends Error {
  constructor(message = 'Secondary instance exhausted token handoff and coordinated recovery') {
    super(message)
    this.name = 'SecondaryHandoffExhaustedError'
  }
}

/**
 * Decide whether a caught error should end the process as a *benign* secondary exit (quiet exit 0)
 * rather than a fatal error (exit 1).
 *
 * Pure and side-effect free so the decision is unit-testable; the live-primary probe
 * (`isCallbackServerListening`) is performed by the caller and passed in as `primaryAlive`.
 *
 * A benign exit requires ALL of:
 *   - the error is a SecondaryHandoffExhaustedError (a secondary that ran out of bounded retries);
 *   - OAuth coordination was actually in play (`skipOAuthSetup` is false — a local no-auth server
 *     never elects a primary, so there is no sibling to defer to);
 *   - a live primary is currently confirmed to own the callback port.
 *
 * If any condition is false the caller must treat the failure as fatal, so a genuine problem is
 * never silently hidden.
 */
export function isBenignSecondaryExit(
  error: unknown,
  context: { skipOAuthSetup: boolean; primaryAlive: boolean },
): boolean {
  if (!(error instanceof SecondaryHandoffExhaustedError)) return false
  if (context.skipOAuthSetup) return false
  return context.primaryAlive
}

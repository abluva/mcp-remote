import { createLockfile, deleteLockfile, getConfigFilePath } from './mcp-auth-config'
import { EventEmitter } from 'events'
import { Server } from 'http'
import express from 'express'
import { AddressInfo } from 'net'
import { unlinkSync } from 'fs'
import {
  log,
  debugLog,
  calculateFallbackPort,
  findExistingClientPort,
  invalidateOAuthClientRegistration,
  isCallbackServerListening,
  setupOAuthCallbackServerWithLongPoll,
} from './utils'

export type AuthCoordinator = {
  initializeAuth: (options?: { force?: boolean }) => Promise<{
    server: Server
    waitForAuthCode: () => Promise<string>
    skipBrowserAuth: boolean
    callbackPort: number
  }>
  resetAuth: () => Promise<void>
}

type PrimaryHandlers = {
  server: Server
  waitForAuthCode: () => Promise<string>
  skipBrowserAuth: boolean
  callbackPort: number
}

/**
 * Waits for the elected primary instance to finish authentication, while detecting
 * whether the primary has gone away (so a secondary can take over).
 *
 * The wait is bounded by the shared `--auth-timeout` (authTimeoutMs): if the primary
 * stays alive but never completes OAuth (e.g. the user closes the browser), the
 * secondary fails with a timeout instead of hanging forever.
 *
 * @param port The primary's callback port
 * @param authTimeoutMs Total upper bound for how long the secondary waits for the primary
 * @returns 'completed' when the primary finished auth (tokens are on disk),
 *          'gone' when the primary is no longer listening (caller should re-elect),
 *          'timeout' when authTimeoutMs elapsed while the primary was still authenticating
 */
async function waitForPrimaryOrTakeover(port: number, authTimeoutMs: number): Promise<'completed' | 'gone' | 'timeout'> {
  log(`Waiting for authentication from the primary on port ${port}...`)
  // authTimeoutMs is the actual TOTAL wait budget for the secondary. Every wait below is
  // clamped to whatever is left of this budget, and once it is exhausted we return 'timeout'
  // immediately — we never spend extra fixed time after the deadline.
  const deadline = Date.now() + authTimeoutMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      log(`Timed out after ${authTimeoutMs}ms waiting for the primary instance to complete authentication`)
      return 'timeout'
    }
    try {
      // Long-poll: primary returns 200 when auth completes, 202 while still in progress.
      // Cap each poll at the remaining budget so the total wait never exceeds authTimeoutMs
      // even if an individual long-poll is still running when the deadline is reached.
      const response = await fetch(`http://127.0.0.1:${port}/wait-for-auth`, {
        signal: AbortSignal.timeout(Math.min(35000, remaining)),
      })
      if (response.status === 200) {
        log('Authentication completed by primary instance')
        return 'completed'
      }
      debugLog('Primary still authenticating (status 202); continuing to wait')
    } catch (error) {
      // A failed poll may mean the primary exited. Confirm with a liveness probe, but only if
      // budget remains — and bound the probe by the remaining budget so it can't run past the
      // deadline.
      debugLog('Primary poll failed; checking whether primary is still alive', error)
      const remainingAfterPoll = deadline - Date.now()
      if (remainingAfterPoll <= 0) {
        log(`Timed out after ${authTimeoutMs}ms waiting for the primary instance to complete authentication`)
        return 'timeout'
      }
      if (!(await isCallbackServerListening(port, Math.min(750, remainingAfterPoll)))) {
        log('Primary instance is no longer listening on the callback port')
        return 'gone'
      }
      // Primary is still alive. If the budget is now spent, fail rather than sleeping past it.
      const remainingAfterProbe = deadline - Date.now()
      if (remainingAfterProbe <= 0) {
        log(`Timed out after ${authTimeoutMs}ms waiting for the primary instance to complete authentication`)
        return 'timeout'
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, remainingAfterProbe)))
    }
  }
}

/**
 * Registers this process as the OAuth primary: writes the (advisory) lockfile and
 * installs cleanup handlers. The exclusive callback-port bind is the real mutex;
 * the lockfile is kept only for observability and stale-detection.
 */
async function registerPrimary(
  serverUrlHash: string,
  server: Server,
  waitForAuthCode: () => Promise<string>,
  actualPort: number,
): Promise<PrimaryHandlers> {
  // If a previously registered client used a different redirect port, drop it so the
  // OAuth client is re-registered against the port we actually bound.
  const registeredPort = await findExistingClientPort(serverUrlHash)
  if (registeredPort && registeredPort !== actualPort) {
    await invalidateOAuthClientRegistration(
      serverUrlHash,
      `registered redirect port ${registeredPort} does not match listener ${actualPort}`,
    )
  }

  debugLog('OAuth callback server running', { port: actualPort })

  log(`Creating lockfile for server ${serverUrlHash} with process ${process.pid} on port ${actualPort}`)
  await createLockfile(serverUrlHash, process.pid, actualPort)

  const cleanupHandler = async () => {
    try {
      log(`Cleaning up lockfile for server ${serverUrlHash}`)
      await deleteLockfile(serverUrlHash)
    } catch (error) {
      log(`Error cleaning up lockfile: ${error}`)
      debugLog('Error cleaning up lockfile', error)
    }
  }

  process.once('exit', () => {
    try {
      // Synchronous version for 'exit' event since we can't use async here
      const configPath = getConfigFilePath(serverUrlHash, 'lock.json')
      unlinkSync(configPath)
      debugLog(`Removed lockfile on exit: ${configPath}`)
    } catch (error) {
      debugLog(`Error removing lockfile on exit:`, error)
    }
  })

  // Also handle SIGINT separately
  process.once('SIGINT', async () => {
    debugLog('Received SIGINT signal, cleaning up')
    await cleanupHandler()
  })

  debugLog('Auth coordination complete, returning primary instance handlers')
  return {
    server,
    waitForAuthCode,
    skipBrowserAuth: false,
    callbackPort: actualPort,
  }
}

/** How long a secondary waits for the primary to persist its tokens, and how often it checks. */
export const TOKEN_HANDOFF_TIMEOUT_MS = 30_000
export const TOKEN_HANDOFF_POLL_INTERVAL_MS = 200

/**
 * Waits until the primary instance's OAuth tokens are actually persisted and readable.
 *
 * Coordination reports "completed" as soon as the primary's callback server *received* the
 * authorization code — strictly earlier than that code being exchanged and the tokens written to
 * disk. A secondary that proceeds in that window reads no tokens and 401s (issue #322). Rather
 * than sleeping a fixed guess, poll the real token store until the tokens land, short-circuiting
 * immediately once they do and giving up after `timeoutMs`.
 *
 * The check is injected (not a second file reader) so the caller polls the exact same source of
 * truth the transport later reads — the proxy passes `authProvider.tokens()`.
 *
 * @param hasPersistedTokens Reads the shared token store; resolves truthy once tokens are readable
 * @param timeoutMs Overall give-up budget (default 30s)
 * @param intervalMs Poll interval between checks (default 200ms)
 * @returns True if tokens became readable before the timeout, false if the budget elapsed first
 */
export async function waitForPrimaryTokens(
  hasPersistedTokens: () => Promise<boolean>,
  timeoutMs: number = TOKEN_HANDOFF_TIMEOUT_MS,
  intervalMs: number = TOKEN_HANDOFF_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (true) {
    let present = false
    try {
      present = await hasPersistedTokens()
    } catch (error) {
      // A transient read error (file mid-write, momentarily unavailable) is treated as "not yet";
      // keep polling until the deadline rather than giving up on one failed read.
      debugLog('Token handoff check failed; will retry', { error })
      present = false
    }

    if (present) {
      debugLog('Primary instance tokens are persisted and readable')
      return true
    }

    if (Date.now() >= deadline) {
      log(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the primary instance to persist its tokens`)
      return false
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Creates a lazy auth coordinator that will only initiate auth when needed
 * @param serverUrlHash The hash of the server URL
 * @param callbackPort The port to use for the callback server
 * @param events The event emitter to use for signaling
 * @returns An AuthCoordinator object with an initializeAuth method
 */
export function createLazyAuthCoordinator(
  serverUrlHash: string,
  callbackPort: number,
  events: EventEmitter,
  authTimeoutMs: number,
): AuthCoordinator {
  let authState: PrimaryHandlers | null = null

  const resetAuth = async () => {
    if (authState?.server) {
      await new Promise<void>((resolve) => authState!.server.close(() => resolve()))
    }
    authState = null
    await deleteLockfile(serverUrlHash)
  }

  return {
    resetAuth,
    initializeAuth: async (options?: { force?: boolean }) => {
      if (authState && !options?.force) {
        debugLog('Auth already initialized, reusing existing state')
        return authState
      }

      if (options?.force) {
        const canReuseExistingServer =
          authState?.server &&
          !authState.skipBrowserAuth &&
          (await isCallbackServerListening(authState.callbackPort))
        if (canReuseExistingServer) {
          log(`Reusing OAuth callback server on port ${authState!.callbackPort} for re-authentication`)
          events.emit('reset-auth-code')
          return authState!
        }
        if (authState?.server) {
          log(`OAuth callback server on port ${callbackPort} is not responding — recreating it`)
          await resetAuth()
        } else {
          log('Starting OAuth callback server for re-authentication')
        }
      }

      log('Initializing auth coordination on-demand')
      debugLog('Initializing auth coordination on-demand', { serverUrlHash, callbackPort })

      authState = await coordinateAuth(serverUrlHash, callbackPort, events, authTimeoutMs, options?.force === true)
      debugLog('Auth coordination completed', { skipBrowserAuth: authState.skipBrowserAuth })
      return authState
    },
  }
}

/**
 * Builds the secondary-instance result: a throwaway server (for API/cleanup compatibility)
 * and a no-op waitForAuthCode. The secondary uses the tokens the primary wrote to disk.
 */
function makeSecondaryResult(): PrimaryHandlers {
  const dummyServer = express().listen(0) // Listen on any available port
  const dummyPort = (dummyServer.address() as AddressInfo).port
  debugLog('Started dummy server for secondary instance', { port: dummyPort })

  // Never awaited in normal operation: callers branch on skipBrowserAuth and reconnect using the
  // tokens the primary wrote to disk. Reject rather than return a promise that never settles, so a
  // caller that does reach it fails fast instead of hanging until the MCP host times out (#322).
  const dummyWaitForAuthCode = () => {
    log('WARNING: waitForAuthCode called in secondary instance - this is unexpected')
    return Promise.reject(
      new Error('waitForAuthCode is not available in a secondary instance; reconnect using the tokens on disk instead'),
    )
  }

  return {
    server: dummyServer,
    waitForAuthCode: dummyWaitForAuthCode,
    skipBrowserAuth: true,
    callbackPort: dummyPort,
  }
}

/**
 * Coordinates authentication between multiple instances of the client/proxy using the
 * callback port as a cross-process mutex (works identically on Windows and POSIX):
 *
 *   - Exclusive bind of the deterministic callback port  -> this process is the PRIMARY
 *   - EADDRINUSE and the occupant is our OAuth callback   -> SECONDARY (wait, then use tokens from disk)
 *   - EADDRINUSE and the occupant is an unrelated process -> genuine conflict: fall back to another port
 *
 * The lockfile is advisory only; the OS-enforced exclusive port bind is the real mutex.
 *
 * @param serverUrlHash The hash of the server URL
 * @param callbackPort The deterministic port to use for the callback server
 * @param events The event emitter to use for signaling
 * @param forcePrimary Forced re-authentication (clears our stale lockfile, then re-elects)
 * @returns An object with the server, waitForAuthCode function, and a flag indicating if browser auth can be skipped
 */
export async function coordinateAuth(
  serverUrlHash: string,
  callbackPort: number,
  events: EventEmitter,
  authTimeoutMs: number,
  forcePrimary = false,
): Promise<PrimaryHandlers> {
  debugLog('Coordinating authentication', { serverUrlHash, callbackPort, forcePrimary })

  // Forced re-auth: drop any stale lockfile we may own, then re-elect via the port bind.
  if (forcePrimary) {
    debugLog('Forced re-authentication: clearing stale lockfile before election')
    await deleteLockfile(serverUrlHash)
  }

  // Walk a deterministic sequence of candidate ports. All concurrent instances compute the
  // same sequence, so the OS-enforced exclusive bind elects exactly one primary per port —
  // even when the canonical port is occupied by an unrelated process (Risk 2). We never let
  // the bind silently drift to a random port, which would let two instances each become their
  // own primary.
  const MAX_ELECTION_ROUNDS = 50
  const MAX_CANDIDATE_PORTS = 10
  let candidateIndex = 0

  for (let round = 0; round < MAX_ELECTION_ROUNDS; round++) {
    const port = candidateIndex === 0 ? callbackPort : calculateFallbackPort(serverUrlHash, candidateIndex)

    // 1) Try to exclusively own this candidate port -> PRIMARY.
    try {
      const { server, waitForAuthCode, port: actualPort } = await setupOAuthCallbackServerWithLongPoll({
        port,
        path: '/oauth/callback',
        events,
        authTimeoutMs,
        allowPortFallback: false, // never drift; we walk a deterministic sequence instead
      })
      if (candidateIndex > 0) {
        log(`Canonical port ${callbackPort} was occupied by an unrelated process; elected primary on fallback port ${actualPort} (pid ${process.pid})`)
      } else {
        log(`Elected OAuth primary on callback port ${actualPort} (pid ${process.pid})`)
      }
      return await registerPrimary(serverUrlHash, server, waitForAuthCode, actualPort)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error
      }
      debugLog('Candidate callback port is in use; probing the occupant', { port })
    }

    // 2) Port is busy — determine whether the occupant is one of our OAuth callback servers.
    let occupantIsOurs = false
    for (let probe = 0; probe < 3; probe++) {
      if (await isCallbackServerListening(port)) {
        occupantIsOurs = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    if (occupantIsOurs) {
      // 3) SECONDARY — wait for that primary to finish, then use tokens from disk.
      log(`Another mcp-remote instance owns callback port ${port}; waiting as secondary`)
      const outcome = await waitForPrimaryOrTakeover(port, authTimeoutMs)
      if (outcome === 'completed') {
        log('Authentication completed by another instance. Using tokens from disk')
        return makeSecondaryResult()
      }
      if (outcome === 'timeout') {
        // Primary stayed alive but never completed OAuth within the shared auth timeout.
        // Fail loudly instead of waiting forever (review comment #1).
        throw new Error(
          `Timed out after ${authTimeoutMs}ms waiting for the primary mcp-remote instance on callback port ${port} to complete authentication`,
        )
      }
      // Primary vanished before completing auth — retry the SAME candidate port to take over.
      log('Primary instance went away before completing auth; attempting takeover')
      continue
    }

    // 4) Genuine unrelated process on this port — advance to the next deterministic candidate.
    //    (Preserves fallback-to-another-port behavior for real conflicts, e.g. issue #306,
    //     but keeps the sequence shared so siblings still elect a single primary.)
    log(`Callback port ${port} is held by an unrelated process; trying the next deterministic fallback port`)
    candidateIndex++
    if (candidateIndex >= MAX_CANDIDATE_PORTS) {
      throw new Error(`Unable to find a free OAuth callback port after ${MAX_CANDIDATE_PORTS} candidates (base ${callbackPort})`)
    }
  }

  throw new Error(`Failed to coordinate OAuth after ${MAX_ELECTION_ROUNDS} rounds on base port ${callbackPort}`)
}

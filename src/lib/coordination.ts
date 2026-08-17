import { createLockfile, deleteLockfile, getConfigFilePath, LockfileData } from './mcp-auth-config'
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
 * Checks if a process with the given PID is running
 * @param pid The process ID to check
 * @returns True if the process is running, false otherwise
 */
export async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0) // Doesn't kill the process, just checks if it exists
    debugLog(`Process ${pid} is running`)
    return true
  } catch (err) {
    debugLog(`Process ${pid} is not running`, err)
    return false
  }
}

/**
 * Checks if a lockfile is valid (process running and endpoint accessible)
 * @param lockData The lockfile data
 * @returns True if the lockfile is valid, false otherwise
 */
export async function isLockValid(lockData: LockfileData): Promise<boolean> {
  debugLog('Checking if lockfile is valid', lockData)

  // Check if the lockfile is too old (over 30 minutes)
  const MAX_LOCK_AGE = 30 * 60 * 1000 // 30 minutes
  if (Date.now() - lockData.timestamp > MAX_LOCK_AGE) {
    log('Lockfile is too old')
    debugLog('Lockfile is too old', {
      age: Date.now() - lockData.timestamp,
      maxAge: MAX_LOCK_AGE,
    })
    return false
  }

  // Check if the process is still running
  if (!(await isPidRunning(lockData.pid))) {
    log('Process from lockfile is not running')
    debugLog('Process from lockfile is not running', { pid: lockData.pid })
    return false
  }

  // Check if the endpoint is accessible
  try {
    debugLog('Checking if endpoint is accessible', { port: lockData.port })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1000)

    const response = await fetch(`http://127.0.0.1:${lockData.port}/wait-for-auth?poll=false`, {
      signal: controller.signal,
    })

    clearTimeout(timeout)

    const isValid = response.status === 200 || response.status === 202
    debugLog(`Endpoint check result: ${isValid ? 'valid' : 'invalid'}`, { status: response.status })
    return isValid
  } catch (error) {
    log(`Error connecting to auth server: ${(error as Error).message}`)
    debugLog('Error connecting to auth server', error)
    return false
  }
}

/**
 * Waits for authentication from another server instance
 * @param port The port to connect to
 * @returns True if authentication completed successfully, false otherwise
 */
export async function waitForAuthentication(port: number): Promise<boolean> {
  log(`Waiting for authentication from the server on port ${port}...`)

  try {
    let attempts = 0
    while (true) {
      attempts++
      const url = `http://127.0.0.1:${port}/wait-for-auth`
      log(`Querying: ${url}`)
      debugLog(`Poll attempt ${attempts}`)

      try {
        const response = await fetch(url)
        debugLog(`Poll response status: ${response.status}`)

        if (response.status === 200) {
          // Auth completed, but we don't return the code anymore
          log(`Authentication completed by other instance`)
          return true
        } else if (response.status === 202) {
          // Continue polling
          log(`Authentication still in progress`)
          debugLog(`Will retry in 1s`)
          await new Promise((resolve) => setTimeout(resolve, 1000))
        } else {
          log(`Unexpected response status: ${response.status}`)
          return false
        }
      } catch (fetchError) {
        debugLog(`Fetch error during poll`, fetchError)
        // If we can't connect, we'll try again after a delay
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  } catch (error) {
    log(`Error waiting for authentication: ${(error as Error).message}`)
    debugLog(`Error waiting for authentication`, error)
    return false
  }
}

/**
 * Waits for the elected primary instance to finish authentication, while detecting
 * whether the primary has gone away (so a secondary can take over).
 *
 * @param port The primary's callback port
 * @returns 'completed' when the primary finished auth (tokens are on disk),
 *          'gone' when the primary is no longer listening (caller should re-elect)
 */
async function waitForPrimaryOrTakeover(port: number): Promise<'completed' | 'gone'> {
  log(`Waiting for authentication from the primary on port ${port}...`)
  while (true) {
    try {
      // Long-poll: primary returns 200 when auth completes, 202 while still in progress.
      const response = await fetch(`http://127.0.0.1:${port}/wait-for-auth`, {
        signal: AbortSignal.timeout(35000),
      })
      if (response.status === 200) {
        log('Authentication completed by primary instance')
        return 'completed'
      }
      debugLog('Primary still authenticating (status 202); continuing to wait')
    } catch (error) {
      // A failed poll may mean the primary exited. Confirm with a quick liveness probe.
      debugLog('Primary poll failed; checking whether primary is still alive', error)
      if (!(await isCallbackServerListening(port))) {
        log('Primary instance is no longer listening on the callback port')
        return 'gone'
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
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

  // This shouldn't actually be called in normal operation, but provide it for API compatibility.
  const dummyWaitForAuthCode = () => {
    log('WARNING: waitForAuthCode called in secondary instance - this is unexpected')
    // Return a promise that never resolves - the client should use the tokens from disk instead.
    return new Promise<string>(() => {})
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
      const outcome = await waitForPrimaryOrTakeover(port)
      if (outcome === 'completed') {
        log('Authentication completed by another instance. Using tokens from disk')
        return makeSecondaryResult()
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

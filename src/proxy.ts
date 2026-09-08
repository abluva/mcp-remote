#!/usr/bin/env node

/**
 * MCP Proxy with OAuth support
 * A bidirectional proxy between a local STDIO MCP server and a remote SSE server with OAuth authentication.
 *
 * Run with: npx tsx proxy.ts https://example.remote/server [callback-port]
 *
 * If callback-port is not specified, an available port will be automatically selected.
 */

import { EventEmitter } from 'events'
import { Server } from 'http'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  connectToRemoteServer,
  log,
  debugLog,
  mcpProxy,
  parseCommandLineArgs,
  setupSignalHandlers,
  TransportStrategy,
  discoverOAuthServerInfo,
  isCallbackServerListening,
  isLocalHttpServer,
  waitForCallbackServer,
  PROTOCOL_2026_07_28,
  type ProtocolMode,
} from './lib/utils'
import { StaticOAuthClientInformationFull, StaticOAuthClientMetadata } from './lib/types'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import { createLazyAuthCoordinator, waitForPrimaryTokens } from './lib/coordination'
import { StatelessHTTPTransport } from './lib/stateless-http-transport'
import { SecondaryHandoffExhaustedError, isBenignSecondaryExit } from './lib/secondary-handoff-exhausted-error'

/**
 * Main function to run the proxy
 */
async function runProxy(
  serverUrl: string,
  callbackPort: number,
  headers: Record<string, string>,
  transportStrategy: TransportStrategy = 'http-first',
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authorizeResource: string,
  ignoredTools: string[],
  authTimeoutMs: number,
  serverUrlHash: string,
  protocolMode: ProtocolMode = 'auto',
) {
  // Set up event emitter for auth flow
  const events = new EventEmitter()
  // Local HTTP sandboxes (e.g. sql-sandbox) do not need OAuth; skip callback server startup.
  const skipOAuthSetup = isLocalHttpServer(serverUrl)

  // Create a lazy auth coordinator
  const authCoordinator = createLazyAuthCoordinator(serverUrlHash, callbackPort, events, authTimeoutMs)

  let discoveryResult: Awaited<ReturnType<typeof discoverOAuthServerInfo>>
  let initialAuthState: {
    server?: Server
    waitForAuthCode: () => Promise<string>
    skipBrowserAuth: boolean
    callbackPort: number
    coordinationPort?: number
  }
  let effectiveCallbackPort = callbackPort
  // The port where the elected OAuth primary actually listens. Defaults to the canonical port, but
  // if #17 coordination elected the primary on a deterministic fallback port (canonical occupied by
  // an unrelated process), this is updated to that real port so the #352 live-primary check probes
  // the correct server rather than the unrelated occupant.
  let primaryCoordinationPort = callbackPort
  let server: Server | undefined

  if (skipOAuthSetup) {
    log('Local HTTP MCP server detected — skipping OAuth callback server')
    discoveryResult = {
      authorizationServerUrl: serverUrl,
      authorizationServerMetadata: undefined,
      protectedResourceMetadata: undefined,
      wwwAuthenticateScope: undefined,
    }
    initialAuthState = {
      skipBrowserAuth: true,
      callbackPort: 0,
      waitForAuthCode: async () => {
        throw new Error('OAuth is disabled for local HTTP MCP servers')
      },
    }
  } else {
    // Discover OAuth server info via Protected Resource Metadata (RFC 9728)
    log('Discovering OAuth server configuration...')
    discoveryResult = await discoverOAuthServerInfo(serverUrl, headers)

    if (discoveryResult.protectedResourceMetadata) {
      log(`Discovered authorization server: ${discoveryResult.authorizationServerUrl}`)
      if (discoveryResult.protectedResourceMetadata.scopes_supported) {
        debugLog('Protected Resource Metadata scopes', {
          scopes_supported: discoveryResult.protectedResourceMetadata.scopes_supported,
        })
      }
    } else {
      debugLog('No Protected Resource Metadata found, using server URL as authorization server')
    }

    if (discoveryResult.serverAccessibleWithoutAuth) {
      // The server is reachable without authentication, so no OAuth flow will run. Skip eager
      // election entirely: otherwise a secondary instance would block forever waiting for an
      // auth completion that never happens (Risk 1). If the server unexpectedly returns 401
      // later, the lazy authInitializer still coordinates on demand.
      log('Remote server is accessible without authentication — skipping eager OAuth coordination')
      initialAuthState = {
        skipBrowserAuth: true,
        callbackPort: 0,
        waitForAuthCode: async () => {
          throw new Error('OAuth is not required for this server')
        },
      }
    } else {
      // Claude Desktop may spawn duplicate processes for the same server. Participate in the
      // cross-process election: exactly one instance binds the callback port (primary) and runs
      // the browser OAuth flow; the others coordinate as secondaries and reuse tokens from disk.
      log(`Ensuring OAuth callback server is listening...`)
      initialAuthState = await authCoordinator.initializeAuth()

      effectiveCallbackPort = initialAuthState.callbackPort
      if (initialAuthState.coordinationPort !== undefined) {
        primaryCoordinationPort = initialAuthState.coordinationPort
      }
      server = initialAuthState.server
      if (!initialAuthState.skipBrowserAuth) {
        await waitForCallbackServer(effectiveCallbackPort)
      }
      if (!initialAuthState.skipBrowserAuth && !(await isCallbackServerListening(effectiveCallbackPort))) {
        throw new Error(`OAuth callback server failed to start on port ${effectiveCallbackPort}`)
      }
      log(`OAuth callback server ready on port ${effectiveCallbackPort}`)
    }
  }

  const authProvider = new NodeOAuthClientProvider({
    serverUrl: discoveryResult.authorizationServerUrl,
    callbackPort: effectiveCallbackPort,
    host,
    clientName: 'MCP CLI Proxy',
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    serverUrlHash,
    authorizationServerMetadata: discoveryResult.authorizationServerMetadata,
    protectedResourceMetadata: discoveryResult.protectedResourceMetadata,
    wwwAuthenticateScope: discoveryResult.wwwAuthenticateScope,
    events,
  })

  // Create the STDIO transport for local connections
  const localTransport = new StdioServerTransport()

  // Define an auth initializer function
  const authInitializer = async (forceReauth = false) => {
    if (skipOAuthSetup) {
      return {
        waitForAuthCode: initialAuthState.waitForAuthCode,
        skipBrowserAuth: true,
        callbackPort: 0,
      }
    }

    if (forceReauth) {
      events.emit('reset-auth-code')
    }
    const authState = await authCoordinator.initializeAuth(forceReauth ? { force: true } : undefined)

    server = authState.server
    effectiveCallbackPort = authState.callbackPort
    primaryCoordinationPort = authState.coordinationPort
    authProvider.setCallbackPort(effectiveCallbackPort)

    if (authState.skipBrowserAuth) {
      log('Authentication was completed by another instance - waiting for its tokens to be persisted')
      // The callback fires before the primary exchanges the code and writes tokens.json, so a fixed
      // sleep can race a slow token exchange (issue #322). Poll the same token store the transport
      // reads (authProvider.tokens()) and proceed as soon as the tokens are actually readable.
      const tokensReady = await waitForPrimaryTokens(async () => Boolean(await authProvider.tokens()))
      if (tokensReady) {
        log('Tokens from the other instance are available - using tokens from disk')
      } else {
        log('Proceeding without confirmed tokens from the other instance; reconnect may re-trigger auth')
      }
    }

    return {
      waitForAuthCode: authState.waitForAuthCode,
      skipBrowserAuth: authState.skipBrowserAuth,
      callbackPort: effectiveCallbackPort,
    }
  }

  try {
    const remoteTransport = await connectToRemoteServer(
      null,
      serverUrl,
      authProvider,
      headers,
      authInitializer,
      transportStrategy,
      new Set(),
      protocolMode,
    )

    const remoteProtocolMode =
      remoteTransport instanceof StatelessHTTPTransport ? PROTOCOL_2026_07_28 : 'legacy'

    const discoverResult =
      remoteTransport instanceof StatelessHTTPTransport ? remoteTransport.discoverResult : undefined

    mcpProxy({
      transportToClient: localTransport,
      transportToServer: remoteTransport,
      ignoredTools,
      authInitializer,
      authProvider,
      serverUrl,
      events,
      callbackPort: effectiveCallbackPort,
      remoteProtocolMode,
      discoverResult,
    })

    await localTransport.start()
    log('Local STDIO server running')
    log(`Proxy established successfully between local STDIO and remote ${remoteTransport.constructor.name}`)
    log('Press Ctrl+C to exit')

    const cleanup = async () => {
      await remoteTransport.close()
      await localTransport.close()
      if (server) {
        server.close()
      }
    }
    setupSignalHandlers(cleanup)
  } catch (error) {
    // A secondary instance that exhausted the bounded token handoff (#352) is a benign terminal
    // *only* when the elected primary is still alive and serving this server: exit quietly (0) so
    // the MCP host does not surface a false "Server disconnected" for a server the primary handles.
    if (error instanceof SecondaryHandoffExhaustedError) {
      // Probe the ACTUAL coordinating-primary port (which may be a deterministic fallback port when
      // the canonical port is held by an unrelated process), not the canonical callbackPort — and
      // never the unrelated occupant, since coordination only reports a secondary after confirming
      // that port hosts our OAuth callback (#352/#17).
      const primaryAlive = !skipOAuthSetup && (await isCallbackServerListening(primaryCoordinationPort))
      if (isBenignSecondaryExit(error, { skipOAuthSetup, primaryAlive })) {
        log('Another mcp-remote instance is already connected and serving this server; this secondary is exiting quietly')
        debugLog('Secondary handoff exhausted with a live primary confirmed; exiting 0', { primaryCoordinationPort })
        if (server) {
          server.close()
        }
        process.exit(0)
      }
      // No live primary could be confirmed — fall through and treat this as a genuine failure.
      debugLog('Secondary handoff exhausted but no live primary confirmed; treating as fatal', { primaryCoordinationPort })
    }
    log('Fatal error:', error)
    if (error instanceof Error && error.message.includes('self-signed certificate in certificate chain')) {
      log(`You may be behind a VPN!

If you are behind a VPN, you can try setting the NODE_EXTRA_CA_CERTS environment variable to point
to the CA certificate file. If using claude_desktop_config.json, this might look like:

{
  "mcpServers": {
    "\${mcpServerName}": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse"
      ],
      "env": {
        "NODE_EXTRA_CA_CERTS": "\${your CA certificate file path}.pem"
      }
    }
  }
}
        `)
    }
    if (server) {
      server.close()
    }
    process.exit(1)
  }
}

parseCommandLineArgs(process.argv.slice(2), 'Usage: npx tsx proxy.ts <https://server-url> [callback-port] [--debug]')
  .then(
    ({
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
    }) => {
      return runProxy(
        serverUrl,
        callbackPort,
        headers,
        transportStrategy,
        host,
        staticOAuthClientMetadata,
        staticOAuthClientInfo,
        authorizeResource,
        ignoredTools,
        authTimeoutMs,
        serverUrlHash,
        protocolMode,
      )
    },
  )
  .catch((error) => {
    log('Fatal error:', error)
    process.exit(1)
  })

#!/usr/bin/env node

/**
 * MCP Client with OAuth support
 * A command-line client that connects to an MCP server using SSE with OAuth authentication.
 *
 * Run with: npx tsx client.ts https://example.remote/server [callback-port]
 *
 * If callback-port is not specified, an available port will be automatically selected.
 */

import { EventEmitter } from 'events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListResourcesResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import {
  connectToRemoteServer,
  log,
  debugLog,
  MCP_REMOTE_VERSION,
  parseCommandLineArgs,
  setupSignalHandlers,
  TransportStrategy,
  discoverOAuthServerInfo,
  type ProtocolMode,
} from './lib/utils'
import { StaticOAuthClientInformationFull, StaticOAuthClientMetadata } from './lib/types'
import { StatelessHTTPTransport } from './lib/stateless-http-transport'
import { createLazyAuthCoordinator } from './lib/coordination'
import { attachClientDiagnostics } from './lib/client-diagnostics'

/**
 * Main function to run the client
 */
async function runClient(
  serverUrl: string,
  callbackPort: number,
  headers: Record<string, string>,
  transportStrategy: TransportStrategy = 'http-first',
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authTimeoutMs: number,
  serverUrlHash: string,
  protocolMode: ProtocolMode = 'auto',
) {
  // Set up event emitter for auth flow
  const events = new EventEmitter()

  // Create a lazy auth coordinator
  const authCoordinator = createLazyAuthCoordinator(serverUrlHash, callbackPort, events, authTimeoutMs)

  // Discover OAuth server info via Protected Resource Metadata (RFC 9728)
  // This probes the MCP server for WWW-Authenticate header and fetches PRM
  log('Discovering OAuth server configuration...')
  const discoveryResult = await discoverOAuthServerInfo(serverUrl, headers)

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

  // Create the OAuth client provider with discovered server info
  const authProvider = new NodeOAuthClientProvider({
    serverUrl: discoveryResult.authorizationServerUrl,
    callbackPort,
    host,
    clientName: 'MCP CLI Client',
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    serverUrlHash,
    authorizationServerMetadata: discoveryResult.authorizationServerMetadata,
    protectedResourceMetadata: discoveryResult.protectedResourceMetadata,
    wwwAuthenticateScope: discoveryResult.wwwAuthenticateScope,
    events,
  })

  // Create the client
  const client = new Client(
    {
      name: 'mcp-remote',
      version: MCP_REMOTE_VERSION,
    },
    {
      capabilities: {},
    },
  )

  // Keep track of the server instance for cleanup
  let server: any = null

  // Define an auth initializer function
  const authInitializer = async () => {
    const authState = await authCoordinator.initializeAuth()

    // Store server in outer scope for cleanup
    server = authState.server

    // If auth was completed by another instance, just log that we'll use the auth from disk
    if (authState.skipBrowserAuth) {
      log('Authentication was completed by another instance - will use tokens from disk...')
      // TODO: remove, the callback is happening before the tokens are exchanged
      //  so we're slightly too early
      await new Promise((res) => setTimeout(res, 1_000))
    }

    return {
      waitForAuthCode: authState.waitForAuthCode,
      skipBrowserAuth: authState.skipBrowserAuth,
      callbackPort: authState.callbackPort,
    }
  }

  try {
    const transport = await connectToRemoteServer(
      client,
      serverUrl,
      authProvider,
      headers,
      authInitializer,
      transportStrategy,
      new Set(),
      protocolMode,
    )

    if (transport instanceof StatelessHTTPTransport) {
      log('Connected using stateless transport (2026-07-28)')
      const toolsResponse = await new Promise<unknown>((resolve, reject) => {
        transport.onmessage = (message) => {
          if ('id' in message && message.id === 1) {
            resolve(message)
          }
        }
        transport.onerror = reject
        transport
          .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
          .catch(reject)
      })
      log('Tools:', JSON.stringify(toolsResponse, null, 2))
      await transport.close()
      if (server) server.close()
      process.exit(0)
      return
    }

    // Attach diagnostics WITHOUT displacing the SDK response dispatcher that
    // Client.connect() installed on transport.onmessage (issue #324). This
    // preserves "Received message" logging and close/error diagnostics while
    // still letting client.request(...) settle normally.
    attachClientDiagnostics(client, transport)

    // Set up cleanup handler
    const cleanup = async () => {
      log('\nClosing connection...')
      await client.close()
      // If auth was initialized and server was created, close it
      if (server) {
        server.close()
      }
    }
    setupSignalHandlers(cleanup)

    log('Connected successfully!')

    try {
      // Request tools list
      log('Requesting tools list...')
      const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema)
      log('Tools:', JSON.stringify(tools, null, 2))
    } catch (e) {
      log('Error requesting tools list:', e)
    }

    try {
      // Request resources list
      log('Requesting resource list...')
      const resources = await client.request({ method: 'resources/list' }, ListResourcesResultSchema)
      log('Resources:', JSON.stringify(resources, null, 2))
    } catch (e) {
      log('Error requesting resources list:', e)
    }

    // log('Listening for messages. Press Ctrl+C to exit.')
    log('Exiting OK...')
    // Only close the server if it was initialized
    if (server) {
      server.close()
    }
    process.exit(0)
  } catch (error) {
    log('Fatal error:', error)
    // Only close the server if it was initialized
    if (server) {
      server.close()
    }
    process.exit(1)
  }
}

// Parse command-line arguments and run the client
parseCommandLineArgs(process.argv.slice(2), 'Usage: npx tsx client.ts <https://server-url> [callback-port] [--debug]')
  .then(
    ({
      serverUrl,
      callbackPort,
      headers,
      transportStrategy,
      host,
      staticOAuthClientMetadata,
      staticOAuthClientInfo,
      authTimeoutMs,
      serverUrlHash,
      protocolMode,
    }) => {
      return runClient(
        serverUrl,
        callbackPort,
        headers,
        transportStrategy,
        host,
        staticOAuthClientMetadata,
        staticOAuthClientInfo,
        authTimeoutMs,
        serverUrlHash,
        protocolMode,
      )
    },
  )
  .catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })

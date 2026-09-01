import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseCommandLineArgs, shouldIncludeTool, mcpProxy, setupOAuthCallbackServerWithLongPoll, getServerUrlHash, mergeHeaders } from './utils'
import { Headers as UndiciHeaders } from 'undici'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { EventEmitter } from 'events'
import express from 'express'

// All sanitizeUrl tests have been moved to the strict-url-sanitise package

describe('Feature: Command Line Arguments Parsing', () => {
  it('Scenario: Parse basic server URL', async () => {
    // Given command line arguments with only a server URL
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the server URL should be correctly extracted
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(typeof result.serverUrl).toBe('string')
  })

  it('Scenario: Parse server URL with callback port', async () => {
    // Given command line arguments with server URL and port
    const args = ['https://example.com/sse', '3000']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then both server URL and callback port should be correctly extracted
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.callbackPort).toBe(3000)
  })

  it('Scenario: Parse localhost URL with HTTP protocol', async () => {
    // Given command line arguments with localhost HTTP URL
    const args = ['http://localhost:8080/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the localhost HTTP URL should be accepted
    expect(result.serverUrl).toBe('http://localhost:8080/sse')
  })

  it('Scenario: Parse 127.0.0.1 URL with HTTP protocol', async () => {
    // Given command line arguments with 127.0.0.1 HTTP URL
    const args = ['http://127.0.0.1:8080/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the 127.0.0.1 HTTP URL should be accepted
    expect(result.serverUrl).toBe('http://127.0.0.1:8080/sse')
  })

  it('Scenario: Parse single custom header', async () => {
    // Given command line arguments with a custom header
    const args = ['https://example.com/sse', '--header', 'foo: taz']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the custom header should be correctly parsed
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.headers).toEqual({ foo: 'taz' })
  })

  it('Scenario: Parse multiple custom headers', async () => {
    // Given command line arguments with multiple custom headers
    const args = ['https://example.com/sse', '--header', 'Authorization: Bearer token123', '--header', 'Content-Type: application/json']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then all custom headers should be correctly parsed
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.headers).toEqual({
      Authorization: 'Bearer token123',
      'Content-Type': 'application/json',
    })
  })

  it('Scenario: Log custom header names without leaking values', async () => {
    // Given command line arguments with a sensitive Authorization header
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--header', 'Authorization: Bearer super-secret-token']
    const usage = 'test usage'

    try {
      // When parsing the command line arguments
      const result = await parseCommandLineArgs(args, usage)

      // Then the header name is logged but its value is not
      expect(result.headers).toEqual({ Authorization: 'Bearer super-secret-token' })
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Using custom header names: Authorization'))
      const loggedOutput = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(loggedOutput).not.toContain('super-secret-token')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('Scenario: Ignore invalid header format', async () => {
    // Given command line arguments with an invalid header format
    const args = ['https://example.com/sse', '--header', 'invalid-header-format']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the invalid header should be ignored and headers should be empty
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.headers).toEqual({})
  })

  it('Scenario: Handle --allow-http flag for non-localhost URLs', async () => {
    // Given command line arguments with HTTP URL and --allow-http flag
    const args = ['http://example.com/sse', '--allow-http']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the HTTP URL should be accepted due to --allow-http flag
    expect(result.serverUrl).toBe('http://example.com/sse')
  })

  it('Scenario: Accept HTTPS URLs without --allow-http flag', async () => {
    // Given command line arguments with HTTPS URL only
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the HTTPS URL should be accepted without any additional flags
    expect(result.serverUrl).toBe('https://example.com/sse')
  })

  it('Scenario: Handle --allow-http with other arguments', async () => {
    // Given command line arguments with HTTP URL, port, --allow-http flag, and custom header
    const args = ['http://example.com/sse', '4000', '--allow-http', '--header', 'Authorization: Bearer abc123']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then all arguments should be correctly parsed including HTTP URL acceptance
    expect(result.serverUrl).toBe('http://example.com/sse')
    expect(result.callbackPort).toBe(4000)
    expect(result.headers).toEqual({ Authorization: 'Bearer abc123' })
  })

  it('Scenario: Use default transport strategy when not specified', async () => {
    // Given command line arguments with only server URL
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default transport strategy should be http-first
    expect(result.transportStrategy).toBe('http-first')
  })

  it('Scenario: Parse transport strategy sse-only', async () => {
    // Given command line arguments with --transport sse-only
    const args = ['https://example.com/sse', '--transport', 'sse-only']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the transport strategy should be set to sse-only
    expect(result.transportStrategy).toBe('sse-only')
  })

  it('Scenario: Parse transport strategy http-only', async () => {
    // Given command line arguments with --transport http-only
    const args = ['https://example.com/sse', '--transport', 'http-only']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the transport strategy should be set to http-only
    expect(result.transportStrategy).toBe('http-only')
  })

  it('Scenario: Parse transport strategy sse-first', async () => {
    // Given command line arguments with --transport sse-first
    const args = ['https://example.com/sse', '--transport', 'sse-first']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the transport strategy should be set to sse-first
    expect(result.transportStrategy).toBe('sse-first')
  })

  it('Scenario: Parse transport strategy http-first', async () => {
    // Given command line arguments with --transport http-first
    const args = ['https://example.com/sse', '--transport', 'http-first']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the transport strategy should be set to http-first
    expect(result.transportStrategy).toBe('http-first')
  })

  it('Scenario: Ignore invalid transport strategy and use default', async () => {
    // Given command line arguments with invalid transport strategy
    const args = ['https://example.com/sse', '--transport', 'invalid-strategy']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the invalid strategy should be ignored and default should be used
    expect(result.transportStrategy).toBe('http-first') // Should fallback to default
  })

  it('Scenario: Use default host when not specified', async () => {
    // Given command line arguments with only server URL
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default host should be localhost
    expect(result.host).toBe('localhost')
  })

  it('Scenario: Parse custom IP host', async () => {
    // Given command line arguments with custom IP host
    const args = ['https://example.com/sse', '--host', '127.0.0.1']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the custom IP host should be correctly set
    expect(result.host).toBe('127.0.0.1')
  })

  it('Scenario: Parse custom domain host', async () => {
    // Given command line arguments with custom domain host
    const args = ['https://example.com/sse', '--host', 'myserver.local']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the custom domain host should be correctly set
    expect(result.host).toBe('myserver.local')
  })

  it('Scenario: Handle host with multiple other arguments', async () => {
    // Given command line arguments with host, port, and transport strategy
    const args = ['https://example.com/sse', '3000', '--host', 'custom.host.com', '--transport', 'sse-only']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then all arguments should be correctly parsed including the host
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.callbackPort).toBe(3000)
    expect(result.host).toBe('custom.host.com')
    expect(result.transportStrategy).toBe('sse-only')
  })

  it('Scenario: Return empty ignored tools array when none specified', async () => {
    // Given command line arguments without --ignore-tool flags
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the ignored tools array should be empty
    expect(result.ignoredTools).toEqual([])
  })

  it('Scenario: Parse single ignored tool', async () => {
    // Given command line arguments with one --ignore-tool flag
    const args = ['https://example.com/sse', '--ignore-tool', 'foo']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the ignored tools array should contain the specified tool
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.ignoredTools).toEqual(['foo'])
  })

  it('Scenario: Parse multiple ignored tools', async () => {
    // Given command line arguments with multiple --ignore-tool flags
    const args = ['https://example.com/sse', '--ignore-tool', 'foo', '--ignore-tool', 'bar', '--ignore-tool', 'baz']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the ignored tools array should contain all specified tools
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.ignoredTools).toEqual(['foo', 'bar', 'baz'])
  })

  it('Scenario: Handle ignored tools with other arguments', async () => {
    // Given command line arguments with ignored tools mixed with other arguments
    const args = [
      'https://example.com/sse',
      '4000',
      '--ignore-tool',
      'tool1',
      '--host',
      'localhost',
      '--ignore-tool',
      'tool2',
      '--transport',
      'sse-only',
    ]
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then all arguments should be correctly parsed including ignored tools
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.callbackPort).toBe(4000)
    expect(result.host).toBe('localhost')
    expect(result.transportStrategy).toBe('sse-only')
    expect(result.ignoredTools).toEqual(['tool1', 'tool2'])
  })

  it('Scenario: Use default auth timeout when not specified', async () => {
    // Given command line arguments without --auth-timeout flag
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default auth timeout should be 30000ms
    expect(result.authTimeoutMs).toBe(30000)
  })

  it('Scenario: Parse valid auth timeout in seconds and convert to milliseconds', async () => {
    // Given command line arguments with valid --auth-timeout
    const args = ['https://example.com/sse', '--auth-timeout', '60']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the timeout should be converted to milliseconds
    expect(result.authTimeoutMs).toBe(60000)
  })

  it('Scenario: Use default timeout when invalid auth timeout value is provided', async () => {
    // Given command line arguments with invalid --auth-timeout value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', 'invalid']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default timeout should be used and warning logged
    expect(result.authTimeoutMs).toBe(30000)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Ignoring invalid auth timeout value: invalid. Must be a positive number.'),
    )

    consoleSpy.mockRestore()
  })

  it('Scenario: Use default timeout when negative auth timeout value is provided', async () => {
    // Given command line arguments with negative --auth-timeout value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', '-30']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default timeout should be used and warning logged
    expect(result.authTimeoutMs).toBe(30000)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Ignoring invalid auth timeout value: -30. Must be a positive number.'),
    )

    consoleSpy.mockRestore()
  })

  it('Scenario: Use default timeout when zero auth timeout value is provided', async () => {
    // Given command line arguments with zero --auth-timeout value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', '0']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default timeout should be used and warning logged
    expect(result.authTimeoutMs).toBe(30000)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Ignoring invalid auth timeout value: 0. Must be a positive number.'),
    )

    consoleSpy.mockRestore()
  })

  it('Scenario: Log when using custom auth timeout', async () => {
    // Given command line arguments with custom --auth-timeout value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', '45']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the custom timeout should be used and logged
    expect(result.authTimeoutMs).toBe(45000)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Using auth callback timeout: 45 seconds'))

    consoleSpy.mockRestore()
  })

  it('Scenario: Parse --protocol before server URL (Claude Desktop flag order)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = [
      '--protocol',
      '2026-07-28',
      '--allow-http',
      'http://127.0.0.1:8095/mcp/v2',
    ]
    const usage = 'test usage'

    const result = await parseCommandLineArgs(args, usage)

    expect(result.serverUrl).toBe('http://127.0.0.1:8095/mcp/v2')
    expect(result.protocolMode).toBe('2026-07-28')

    consoleSpy.mockRestore()
  })

  it('Scenario: Suppresses LOG when using --silent', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', '45', '--silent']
    const usage = 'test usage'

    const result = await parseCommandLineArgs(args, usage)

    expect(result.authTimeoutMs).toBe(45000)
    expect(consoleSpy).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

describe('Feature: Tool Filtering with Ignore Patterns', () => {
  it('Scenario: Single wildcard pattern ignores matching tools', () => {
    // Given ignore patterns with create* wildcard
    const ignorePatterns = ['create*']

    // When checking if createTask should be included
    const result1 = shouldIncludeTool(ignorePatterns, 'createTask')
    // Then it should be excluded (return false)
    expect(result1).toBe(false)

    // When checking if getTask should be included
    const result2 = shouldIncludeTool(ignorePatterns, 'getTask')
    // Then it should be included (return true)
    expect(result2).toBe(true)
  })

  it('Scenario: Multiple wildcard patterns ignore matching tools', () => {
    // Given ignore patterns with create* and put* wildcards
    const ignorePatterns = ['create*', 'put*']

    // When checking if createTask should be included
    const result1 = shouldIncludeTool(ignorePatterns, 'createTask')
    // Then it should be excluded (return false)
    expect(result1).toBe(false)

    // When checking if infoTask should be included
    const result2 = shouldIncludeTool(ignorePatterns, 'infoTask')
    // Then it should be included (return true)
    expect(result2).toBe(true)
  })

  it('Scenario: Suffix wildcard pattern ignores matching tools', () => {
    // Given ignore patterns with *account suffix wildcard
    const ignorePatterns = ['*account']

    // When checking various account-related tools
    const result1 = shouldIncludeTool(ignorePatterns, 'getAccount')
    const result2 = shouldIncludeTool(ignorePatterns, 'putAccount')
    const result3 = shouldIncludeTool(ignorePatterns, 'account')

    // Then all should be excluded (return false)
    expect(result1).toBe(false)
    expect(result2).toBe(false)
    expect(result3).toBe(false)
  })

  it('Scenario: Empty ignore patterns include all tools', () => {
    // Given empty ignore patterns
    const ignorePatterns: string[] = []

    // When checking any tool
    const result = shouldIncludeTool(ignorePatterns, 'anyTool')

    // Then it should be included (return true)
    expect(result).toBe(true)
  })

  it('Scenario: Non-matching patterns include tools', () => {
    // Given ignore patterns that don't match the tool
    const ignorePatterns = ['delete*', 'remove*']

    // When checking a tool that doesn't match any pattern
    const result = shouldIncludeTool(ignorePatterns, 'createTask')

    // Then it should be included (return true)
    expect(result).toBe(true)
  })

  it('Scenario: Exact match without wildcards', () => {
    // Given ignore patterns with exact tool names
    const ignorePatterns = ['exactTool', 'anotherTool']

    // When checking the exact tool name
    const result1 = shouldIncludeTool(ignorePatterns, 'exactTool')
    // Then it should be excluded (return false)
    expect(result1).toBe(false)

    // When checking a different tool name
    const result2 = shouldIncludeTool(ignorePatterns, 'differentTool')
    // Then it should be included (return true)
    expect(result2).toBe(true)
  })
})

describe('Feature: MCP Proxy', () => {
  it('Scenario: Proxy initialize message from client to server', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when client sends an initialize message
    const initializeMessage = {
      jsonrpc: '2.0' as const,
      method: 'initialize',
      id: '1',
      params: {
        clientInfo: {
          name: 'Test Client',
          version: '1.0.0',
        },
      },
    }

    // Simulate client sending a message by calling the message handler directly
    if (mockTransportToClient.onmessage) {
      mockTransportToClient.onmessage(initializeMessage)
    }

    // Then the message should be forwarded to the server
    expect(mockTransportToServer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'initialize',
        id: '1',
        params: expect.objectContaining({
          clientInfo: expect.objectContaining({
            name: expect.stringContaining('Test Client'),
            version: '1.0.0',
          }),
        }),
      }),
    )
  })

  it('Scenario: Proxy server response back to client', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // First simulate client sending a request (so there's a pending request)
    const clientRequest = {
      jsonrpc: '2.0' as const,
      method: 'initialize',
      id: '1',
      params: {
        clientInfo: {
          name: 'Test Client',
          version: '1.0.0',
        },
      },
    }

    if (mockTransportToClient.onmessage) {
      mockTransportToClient.onmessage(clientRequest)
    }

    // Clear the previous call
    vi.clearAllMocks()

    // Now simulate server sending a response message
    const serverResponse = {
      jsonrpc: '2.0' as const,
      id: '1',
      result: {
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
        serverInfo: {
          name: 'Atlassian MCP',
          version: '1.0.0',
        },
      },
    }

    // Simulate server sending a response by calling the message handler directly
    if (mockTransportToServer.onmessage) {
      mockTransportToServer.onmessage(serverResponse)
    }

    // Then the response should be forwarded to the client
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: '1',
        result: {
          capabilities: {
            tools: {
              listChanged: true,
            },
          },
          serverInfo: {
            name: 'Atlassian MCP',
            version: '1.0.0',
          },
        },
      }),
    )
  })

  it('Scenario: Close server transport when client transport closes', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when client transport closes
    if (mockTransportToClient.onclose) {
      mockTransportToClient.onclose()
    }

    // Then server transport should also be closed
    expect(mockTransportToServer.close).toHaveBeenCalled()
  })

  it('Scenario: Close client transport when server transport closes', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when server transport closes
    if (mockTransportToServer.onclose) {
      mockTransportToServer.onclose()
    }

    // Then client transport should also be closed
    expect(mockTransportToClient.close).toHaveBeenCalled()
  })

  it('Scenario: Filter tools in tools/list response when ignoredTools is configured', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy with ignored tools
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: ['delete*', 'remove*'],
    })

    // First simulate client sending a tools/list request
    const toolsListRequest = {
      jsonrpc: '2.0' as const,
      method: 'tools/list',
      id: '2',
      params: {},
    }

    if (mockTransportToClient.onmessage) {
      mockTransportToClient.onmessage(toolsListRequest)
    }

    // Clear the previous call
    vi.clearAllMocks()

    // Now simulate server sending a tools/list response with various tools
    const serverToolsResponse = {
      jsonrpc: '2.0' as const,
      id: '2',
      result: {
        tools: [
          { name: 'createTask', description: 'Create a new task' },
          { name: 'deleteTask', description: 'Delete a task' },
          { name: 'updateTask', description: 'Update a task' },
          { name: 'removeUser', description: 'Remove a user' },
          { name: 'listTasks', description: 'List all tasks' },
        ],
      },
    }

    // Simulate server sending a response
    if (mockTransportToServer.onmessage) {
      mockTransportToServer.onmessage(serverToolsResponse)
    }

    // Then the response should be forwarded to the client with filtered tools
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: '2',
        result: {
          tools: [
            { name: 'createTask', description: 'Create a new task' },
            { name: 'updateTask', description: 'Update a task' },
            { name: 'listTasks', description: 'List all tasks' },
          ],
        },
      }),
    )
  })

  it('Scenario: Block tools/call for ignored tools with delete* filter', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy with delete* filter
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: ['delete*'],
    })

    // And when client tries to call a deleteTask tool
    const toolsCallMessage = {
      jsonrpc: '2.0' as const,
      method: 'tools/call',
      id: '3',
      params: {
        name: 'deleteTask',
        arguments: {
          taskId: '1',
        },
        _meta: {
          progressToken: 1,
        },
      },
    }

    // Simulate client sending the tools/call message
    if (mockTransportToClient.onmessage) {
      mockTransportToClient.onmessage(toolsCallMessage)
    }

    // Then the call should NOT be forwarded to the server
    expect(mockTransportToServer.send).not.toHaveBeenCalled()

    // And an error response should be sent back to the client
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: '3',
        error: expect.objectContaining({
          code: expect.any(Number),
          message: expect.stringContaining('Tool "deleteTask" is not available'),
        }),
      }),
    )
  })

  it('Scenario: Handle server-initiated requests (without corresponding client request)', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when server sends a ping message (server-initiated, no corresponding client request)
    const serverPingMessage = {
      jsonrpc: '2.0' as const,
      method: 'ping',
      id: 'server-ping-1',
    }

    // Simulate server sending the message
    if (mockTransportToServer.onmessage) {
      mockTransportToServer.onmessage(serverPingMessage)
    }

    // Then the message should be forwarded to the client without errors
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'ping',
        id: 'server-ping-1',
      }),
    )
  })

  it('Scenario: Handle server-initiated response messages without corresponding request', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when server sends a response with an ID that has no corresponding request
    const orphanedResponse = {
      jsonrpc: '2.0' as const,
      id: 'unknown-request-id',
      result: {},
    }

    // Simulate server sending a response without a matching request
    if (mockTransportToServer.onmessage) {
      mockTransportToServer.onmessage(orphanedResponse)
    }

    // Then the response should still be forwarded to the client
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'unknown-request-id',
        result: {},
      }),
    )
  })
})

describe('setupOAuthCallbackServerWithLongPoll', () => {
  let server: any
  let events: EventEmitter

  beforeEach(() => {
    events = new EventEmitter()
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('should use custom timeout when authTimeoutMs is provided', async () => {
    const customTimeout = 5000
    const result = await setupOAuthCallbackServerWithLongPoll({
      port: 0, // Use any available port
      path: '/oauth/callback',
      events,
      authTimeoutMs: customTimeout,
    })

    server = result.server

    // Test that the server was created
    expect(server).toBeDefined()
    expect(typeof result.waitForAuthCode).toBe('function')
  })

  it('should use default timeout when authTimeoutMs is not provided', async () => {
    const result = await setupOAuthCallbackServerWithLongPoll({
      port: 0, // Use any available port
      path: '/oauth/callback',
      events,
    })

    server = result.server

    // Test that the server was created with defaults
    expect(server).toBeDefined()
    expect(typeof result.waitForAuthCode).toBe('function')
  })
})

describe('Feature: Server URL Hash Generation', () => {
  it('Scenario: Generate consistent hash for same config', () => {
    const hash1 = getServerUrlHash('https://example.com', 'resource1', { Auth: 'token' })
    const hash2 = getServerUrlHash('https://example.com', 'resource1', { Auth: 'token' })
    expect(hash1).toBe(hash2)
  })

  it('Scenario: Generate different hash for different resources', () => {
    const hash1 = getServerUrlHash('https://example.com', 'resource1')
    const hash2 = getServerUrlHash('https://example.com', 'resource2')
    expect(hash1).not.toBe(hash2)
  })

  it('Scenario: Generate different hash for different headers', () => {
    const hash1 = getServerUrlHash('https://example.com', '', { Auth: 'token1' })
    const hash2 = getServerUrlHash('https://example.com', '', { Auth: 'token2' })
    expect(hash1).not.toBe(hash2)
  })

  it('Scenario: Handle header key ordering consistently', () => {
    const hash1 = getServerUrlHash('https://example.com', '', { B: '2', A: '1' })
    const hash2 = getServerUrlHash('https://example.com', '', { A: '1', B: '2' })
    expect(hash1).toBe(hash2)
  })

  it('Scenario: Backward compatible with no resource or headers', () => {
    const hash1 = getServerUrlHash('https://example.com')
    const hash2 = getServerUrlHash('https://example.com', '', {})
    expect(hash1).toBe(hash2)
  })

  it('Scenario: Empty string resource same as undefined', () => {
    const hash1 = getServerUrlHash('https://example.com', '')
    const hash2 = getServerUrlHash('https://example.com')
    expect(hash1).toBe(hash2)
  })
})

import { mcpProxy as mcpProxyForSse, PROTOCOL_2026_07_28 } from './utils'
import { ReinitAwareSSEClientTransport } from './reinit-aware-sse-transport'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

describe('Feature: Legacy SSE session recovery (issue #269)', () => {
  function makeClient() {
    return {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: undefined as any,
      onclose: undefined as any,
      onerror: undefined as any,
    } as unknown as Transport
  }

  /** A ReinitAwareSSEClientTransport with network methods stubbed so mcpProxy wires reinit onto it. */
  function makeSseServer(behavior?: (msg: any, ctx: { respond: (r: any) => void; server: any; sent: any[] }) => void) {
    const server = new ReinitAwareSSEClientTransport(new URL('http://localhost/sse')) as any
    const sent: any[] = []
    server.start = vi.fn().mockResolvedValue(undefined)
    server.close = vi.fn().mockResolvedValue(undefined)
    server.setProtocolVersion = vi.fn()
    server.finishAuth = vi.fn().mockResolvedValue(undefined)
    const respond = (r: any) => server.onmessage?.(r)
    server.send = vi.fn(async (msg: any) => {
      sent.push(msg)
      behavior?.(msg, { respond, server, sent })
    })
    return { server, sent }
  }

  const isReinit = (m: any) => typeof m.id === 'string' && m.id.startsWith('mcp-remote-reinit-')

  function sendInitialize(client: Transport, id: string | number = '1') {
    client.onmessage?.({
      jsonrpc: '2.0',
      method: 'initialize',
      id,
      params: { clientInfo: { name: 'Test Client', version: '1.0.0' }, protocolVersion: '2024-11-05' },
    } as any)
  }

  it('Scenario: Rotation replays initialize with an internal sentinel id and sends notifications/initialized', async () => {
    const client = makeClient()
    const { server, sent } = makeSseServer((msg, { respond }) => {
      if (isReinit(msg)) setTimeout(() => respond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26' } }), 0)
    })

    mcpProxyForSse({ transportToClient: client, transportToServer: server, ignoredTools: [] })
    sendInitialize(client)

    // When the SSE session rotates
    server.onSessionRotated!()

    await vi.waitFor(() => expect(sent.some((m) => m.method === 'notifications/initialized')).toBe(true))

    const replay = sent.find(isReinit)
    expect(replay).toBeDefined()
    expect(replay.method).toBe('initialize')
    expect(replay.params.clientInfo.name).toContain('Test Client')

    // Protocol version negotiated by the new session is applied to the transport
    expect(server.setProtocolVersion).toHaveBeenCalledWith('2025-03-26')

    // The internal reinit response is consumed by the proxy, never forwarded to the local client
    expect(client.send).not.toHaveBeenCalledWith(expect.objectContaining({ id: replay.id }))
  })

  it('Scenario: A normal request waits until reinit completes before being sent', async () => {
    const client = makeClient()
    const { server, sent } = makeSseServer((msg, { respond }) => {
      if (isReinit(msg)) {
        setTimeout(() => respond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26' } }), 0)
      } else if (msg.method === 'tools/call') {
        setTimeout(() => respond({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }), 0)
      }
    })

    mcpProxyForSse({ transportToClient: client, transportToServer: server, ignoredTools: [] })
    sendInitialize(client)

    // Rotation starts reinit; a tool call arrives while reinit is in flight
    server.onSessionRotated!()
    client.onmessage?.({ jsonrpc: '2.0', method: 'tools/call', id: '2', params: { name: 'echo' } } as any)

    await vi.waitFor(() => expect(sent.some((m) => m.method === 'tools/call' && m.id === '2')).toBe(true))

    const reinitIdx = sent.findIndex(isReinit)
    const notifIdx = sent.findIndex((m) => m.method === 'notifications/initialized')
    const callIdx = sent.findIndex((m) => m.method === 'tools/call' && m.id === '2')

    // Order: initialize replay -> notifications/initialized -> the queued tool call
    expect(reinitIdx).toBeGreaterThanOrEqual(0)
    expect(notifIdx).toBeGreaterThan(reinitIdx)
    expect(callIdx).toBeGreaterThan(notifIdx)
  })

  it('Scenario: Concurrent rotation and requests share a single reinit', async () => {
    const client = makeClient()
    const { server, sent } = makeSseServer((msg, { respond }) => {
      if (isReinit(msg)) {
        setTimeout(() => respond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26' } }), 5)
      } else if (msg.method === 'tools/call') {
        setTimeout(() => respond({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }), 0)
      }
    })

    mcpProxyForSse({ transportToClient: client, transportToServer: server, ignoredTools: [] })
    sendInitialize(client)

    // Two rotations and two requests race while the session is dead
    server.onSessionRotated!()
    server.onSessionRotated!()
    client.onmessage?.({ jsonrpc: '2.0', method: 'tools/call', id: '2', params: { name: 'a' } } as any)
    client.onmessage?.({ jsonrpc: '2.0', method: 'tools/call', id: '3', params: { name: 'b' } } as any)

    await vi.waitFor(() => expect(sent.filter((m) => m.method === 'tools/call').length).toBe(2))

    // Exactly one handshake and one notifications/initialized are shared by all callers
    expect(sent.filter(isReinit)).toHaveLength(1)
    expect(sent.filter((m) => m.method === 'notifications/initialized')).toHaveLength(1)
  })

  it('Scenario: A -32602/-32600 error response does not trigger reinit', async () => {
    const client = makeClient()
    const { server, sent } = makeSseServer()

    mcpProxyForSse({ transportToClient: client, transportToServer: server, ignoredTools: [] })
    sendInitialize(client)

    // Server answers a tool call with an ordinary JSON-RPC error (not a rotation signal)
    client.onmessage?.({ jsonrpc: '2.0', method: 'tools/call', id: '2', params: { name: 'x' } } as any)
    server.onmessage?.({ jsonrpc: '2.0', id: '2', error: { code: -32602, message: 'Invalid request parameters' } })
    server.onmessage?.({ jsonrpc: '2.0', id: '3', error: { code: -32600, message: 'Invalid request' } })

    await vi.waitFor(() => expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ id: '2' })))

    // No re-initialize handshake was sent
    expect(sent.filter(isReinit)).toHaveLength(0)
  })

  it('Scenario: Rotation with interactive OAuth recovers auth then retries the handshake once', async () => {
    const client = makeClient()
    let reinitAttempts = 0
    const { server, sent } = makeSseServer((msg, { respond, server }) => {
      if (isReinit(msg)) {
        reinitAttempts++
        if (reinitAttempts === 1) {
          // First handshake on the fresh session needs auth: mimic SSE send() (fires onerror + throws)
          server.onerror?.(new UnauthorizedError())
          throw new UnauthorizedError()
        }
        setTimeout(() => respond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26' } }), 0)
      }
    })

    const authInitializer = vi
      .fn()
      .mockResolvedValue({ waitForAuthCode: vi.fn().mockResolvedValue('auth-code'), skipBrowserAuth: true, callbackPort: 0 })

    mcpProxyForSse({ transportToClient: client, transportToServer: server, ignoredTools: [], authInitializer })
    sendInitialize(client)

    server.onSessionRotated!()

    await vi.waitFor(() => expect(sent.some((m) => m.method === 'notifications/initialized')).toBe(true))

    // OAuth recovery ran once (single-flight) and the handshake was retried exactly once
    expect(authInitializer).toHaveBeenCalledTimes(1)
    expect(server.finishAuth).toHaveBeenCalledTimes(1)
    expect(reinitAttempts).toBe(2)
    expect(server.setProtocolVersion).toHaveBeenCalledWith('2025-03-26')
  })

  it('Scenario: OAuth recovery failure during reinit does not loop', async () => {
    const client = makeClient()
    let reinitAttempts = 0
    const { server, sent } = makeSseServer((msg) => {
      if (isReinit(msg)) {
        reinitAttempts++
        throw new UnauthorizedError()
      }
    })

    const authInitializer = vi.fn().mockRejectedValue(new Error('auth failed'))

    mcpProxyForSse({ transportToClient: client, transportToServer: server, ignoredTools: [], authInitializer })
    sendInitialize(client)

    server.onSessionRotated!()

    // Give the recovery attempt time to settle
    await new Promise((r) => setTimeout(r, 20))

    // Auth was attempted once and the handshake was not retried after the auth failure (no loop)
    expect(authInitializer).toHaveBeenCalledTimes(1)
    expect(reinitAttempts).toBe(1)
    expect(sent.filter((m) => m.method === 'notifications/initialized')).toHaveLength(0)
  })

  it('Scenario: OAuth-only recovery (no SSE rotation) is unchanged', async () => {
    const client = makeClient()
    const serverSend = vi
      .fn()
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValue(undefined)
    const server = {
      send: serverSend,
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      finishAuth: vi.fn().mockResolvedValue(undefined),
      onmessage: undefined as any,
      onclose: undefined as any,
      onerror: undefined as any,
    } as unknown as Transport

    const authInitializer = vi
      .fn()
      .mockResolvedValue({ waitForAuthCode: vi.fn().mockResolvedValue('auth-code'), skipBrowserAuth: true, callbackPort: 0 })

    mcpProxyForSse({ transportToClient: client, transportToServer: server, ignoredTools: [], authInitializer })

    client.onmessage?.({ jsonrpc: '2.0', method: 'tools/call', id: '9', params: { name: 'ping' } } as any)

    await vi.waitFor(() => expect((server as any).finishAuth).toHaveBeenCalledTimes(1))

    // The failed request is retried after re-auth; no reinit handshake exists on this path
    await vi.waitFor(() => expect(serverSend).toHaveBeenCalledTimes(2))
    expect(serverSend.mock.calls.every(([m]) => !(typeof m.id === 'string' && m.id.startsWith('mcp-remote-reinit-')))).toBe(true)
  })

  it('Scenario: Stateless 2026-07-28 path answers initialize locally and never reinits', async () => {
    const client = makeClient()
    const server = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: undefined as any,
      onclose: undefined as any,
      onerror: undefined as any,
    } as unknown as Transport

    mcpProxyForSse({
      transportToClient: client,
      transportToServer: server,
      ignoredTools: [],
      remoteProtocolMode: PROTOCOL_2026_07_28,
    })

    // initialize is shimmed locally: answered to the client, not forwarded to the remote
    client.onmessage?.({
      jsonrpc: '2.0',
      method: 'initialize',
      id: '1',
      params: { clientInfo: { name: 'Test Client', version: '1.0.0' }, protocolVersion: '2024-11-05' },
    } as any)

    await vi.waitFor(() => expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ id: '1' })))
    expect(server.send).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'initialize' }))
    // A plain (non-SSE) transport never gets the rotation hook wired
    expect((server as any).onSessionRotated).toBeUndefined()
  })
})

describe('Feature: Merging headers for the SSE request (#335 / geelen#157)', () => {
  it('Scenario: Keep the headers the SDK set, whichever Headers class built them', () => {
    // Given headers from the SDK, which builds them with the *global* class rather than undici's
    const fromSdk = new globalThis.Headers({ 'mcp-protocol-version': '2025-06-18' })

    // When they are merged
    const merged = mergeHeaders(fromSdk, { Accept: 'text/event-stream' })

    // Then they survive, rather than being spread away to nothing
    expect(merged).toEqual({ 'mcp-protocol-version': '2025-06-18', Accept: 'text/event-stream' })
  })

  it('Scenario: Accept undici Headers just the same', () => {
    const merged = mergeHeaders(new UndiciHeaders({ 'x-from-undici': 'yes' }))

    expect(merged).toEqual({ 'x-from-undici': 'yes' })
  })

  it('Scenario: One header per name, however its writers spelled it', () => {
    // Given the same header arriving in two cases, as it does when the SDK's lowercased
    // `authorization` meets the `Authorization` added alongside it
    const merged = mergeHeaders(new globalThis.Headers({ authorization: 'Bearer stale' }), { Authorization: 'Bearer fresh' })

    // Then only the later one is sent. Emitting both would have fetch join them into
    // "Bearer stale, Bearer fresh", which no server accepts.
    expect(Object.keys(merged)).toEqual(['Authorization'])
    expect(merged.Authorization).toBe('Bearer fresh')
  })

  it('Scenario: A custom header keeps the case it was written in', () => {
    // Given a server that matches its header names case-sensitively
    const merged = mergeHeaders(new globalThis.Headers({ accept: 'text/event-stream' }), { Company: 'ACME', TenantId: 'abc' })

    // Then --header values are passed on spelled the way the user spelled them
    expect(merged.Company).toBe('ACME')
    expect(merged.TenantId).toBe('abc')
  })

  it('Scenario: Accept the other shapes fetch allows', () => {
    expect(mergeHeaders(undefined)).toEqual({})
    expect(mergeHeaders({ a: '1' }, undefined, { b: '2' })).toEqual({ a: '1', b: '2' })
    // An array of pairs, whose own `entries()` would yield [index, pair] if it were treated as iterable
    expect(mergeHeaders([['x-pair', 'value']])).toEqual({ 'x-pair': 'value' })
  })

  it('Scenario: mcp-protocol-version survives the exact SSE reconnect merge order', () => {
    // Given what the SSE eventSourceInit.fetch merges on a reconnect: the SDK's global Headers
    // (carrying mcp-protocol-version + a lowercased authorization), the --header closure, the
    // token-derived Authorization, and Accept — in that precedence order.
    const sdkHeaders = new globalThis.Headers({
      'mcp-protocol-version': '2025-11-25',
      authorization: 'Bearer sdk-copy',
    })

    const merged = mergeHeaders(
      sdkHeaders,
      { Company: 'ACME' },
      { Authorization: 'Bearer user-token-abc' },
      { Accept: 'text/event-stream' },
    )

    // Then the SDK-only header is preserved, the custom header keeps its casing, and there is a
    // single Authorization spelled the way its last writer spelled it.
    expect(merged['mcp-protocol-version']).toBe('2025-11-25')
    expect(merged.Company).toBe('ACME')
    expect(merged.Accept).toBe('text/event-stream')
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === 'authorization')).toEqual(['Authorization'])
    expect(merged.Authorization).toBe('Bearer user-token-abc')
  })
})

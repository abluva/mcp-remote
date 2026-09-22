import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * Issue #286 mid-session re-authentication regression (full flow).
 *
 * Proves, against the REAL built dist/proxy.js and the [::1] OAuth+MCP fixture:
 *   1. the proxy starts with --allow-http and connect()/tools/list succeed WITHOUT OAuth,
 *   2. a later protected tools/call causes a mid-session HTTP 401,
 *   3. mcp-remote enters mid-session OAuth recovery and logs an authorize URL,
 *   4. the harness completes the flow headlessly (follow /authorize -> deliver the code to
 *      mcp-remote's callback server), mcp-remote performs the /token exchange itself,
 *   5. the originally-failed tools/call is retried and returns the expected nonce.
 *
 * The fixture's /authorize redirect is enabled via AUTHORIZE_REDIRECT=1.
 */

const regressionDir = dirname(fileURLToPath(import.meta.url))
const repoDir = process.env.MCP_REMOTE_BASE_PATH ?? join(regressionDir, '..', '..')
const proxyPath = join(repoDir, 'dist', 'proxy.js')
const fixturePath = join(regressionDir, 'fixture-oauth-mcp.mjs')

const FIXTURE_PORT = 4020
const HOST = '::1'
const mcpUrl = `http://[${HOST}]:${FIXTURE_PORT}/mcp`
const debugStateUrl = `http://[${HOST}]:${FIXTURE_PORT}/debug/state`

const OVERALL_DEADLINE_MS = 40000
const SIGNAL_TIMEOUT_MS = 25000

// -----------------------------------------------------
// Utilities
// -----------------------------------------------------

function isPortInUse(port, host = HOST) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function waitForPort(port, host = HOST, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    function tryConnect() {
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy()
        resolve()
      })
      socket.on('error', () => {
        socket.destroy()
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Timed out waiting for [${host}]:${port}`))
          return
        }
        setTimeout(tryConnect, 150)
      })
    }
    tryConnect()
  })
}

async function waitFor(predicate, { timeoutMs, intervalMs = 150, label }) {
  const started = Date.now()
  for (;;) {
    let value
    try {
      value = await predicate()
    } catch {
      value = null
    }
    if (value) return value
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for: ${label ?? 'condition'}`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function fetchState() {
  const res = await fetch(debugStateUrl)
  if (!res.ok) throw new Error(`/debug/state returned ${res.status}`)
  return res.json()
}

function printResult(name, passed, details = '') {
  console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}`)
  if (details) console.log(`  ${details}`)
}

/** Strips authorize URLs (state / PKCE challenge) out of proxy output before printing. */
function redactAuthUrls(text) {
  return text.replace(/(Please authorize this client by visiting:\s*)\S+/g, '$1<redacted authorize URL>')
}

// -----------------------------------------------------
// Main
// -----------------------------------------------------

let fixtureChild = null
let client = null
let transport = null
let configDir = null
let stderrBuffer = ''

async function cleanup() {
  try {
    if (client) await client.close()
  } catch {
    // ignore
  }
  try {
    if (transport) await transport.close()
  } catch {
    // ignore
  }
  if (fixtureChild && fixtureChild.exitCode === null && !fixtureChild.killed) {
    fixtureChild.kill()
  }
  if (configDir) {
    try {
      rmSync(configDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

async function run() {
  console.log('mcp-remote #286 mid-session re-auth regression')
  console.log(`Node: ${process.version}`)
  console.log(`Proxy: ${proxyPath}`)

  if (!existsSync(proxyPath)) throw new Error(`proxy not found: ${proxyPath}`)
  if (!existsSync(fixturePath)) throw new Error(`fixture not found: ${fixturePath}`)

  console.log('\nChecking fixture port...')
  if (await isPortInUse(FIXTURE_PORT)) {
    throw new Error(`Fixture port ${FIXTURE_PORT} already in use.`)
  }

  // Fresh, isolated config dir so no cached ~/.mcp-auth token can mask the 401.
  configDir = mkdtempSync(join(tmpdir(), 'mcp-remote-286-'))
  console.log(`Isolated MCP_REMOTE_CONFIG_DIR: ${configDir}`)

  // Start the combined fixture with the authorize redirect enabled, so the recovery
  // flow can be completed headlessly by this harness.
  fixtureChild = spawn(process.execPath, [fixturePath], {
    cwd: regressionDir,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FIXTURE_PORT: String(FIXTURE_PORT), AUTHORIZE_REDIRECT: '1' },
  })
  fixtureChild.stdout.on('data', (d) => {
    const t = d.toString().trim()
    if (t) console.log(`[fixture] ${t}`)
  })
  fixtureChild.stderr.on('data', (d) => {
    const t = d.toString().trim()
    if (t) console.error(`[fixture stderr] ${t}`)
  })

  console.log('\nWaiting for fixture...')
  await waitForPort(FIXTURE_PORT)
  console.log('Fixture is ready.\n')

  // Spawn the REAL proxy over stdio. Watch its stderr for the authorize URL.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      proxyPath,
      mcpUrl,
      '--allow-http',
      '--transport',
      'http-only',
      '--protocol',
      'legacy',
      '--static-oauth-client-info',
      '{"client_id":"test-client"}',
    ],
    env: { ...process.env, MCP_REMOTE_CONFIG_DIR: configDir },
    stderr: 'pipe',
  })

  // There can be MORE THAN ONE "Please authorize" URL: an early one (e.g. the SDK transport's
  // own auth on the 401) appears before mcpProxy's mid-session recovery. Completing that early
  // URL is useless — mcpProxy then resets authCode and starts a fresh flow, discarding the code.
  // So we only select the authorize URL that appears AFTER the mcpProxy recovery marker AND the
  // subsequent authCode reset.
  const RECOVERY_MARK = 'Authentication required during active session'
  const AUTHCODE_RESET = 'Resetting authCode to null due to new authorization flow'
  const AUTH_URL_RE = /Please authorize this client by visiting:\s*(\S+)/g

  const observedAuthUrls = [] // [{ url, index }]
  let selectedAuthUrl = null
  let selectedAuthUrlIndex = -1
  let resolveAuthUrl
  const authUrlPromise = new Promise((resolve) => (resolveAuthUrl = resolve))

  function scanStderrForRecoveryUrl() {
    // Refresh the full list of observed authorize URLs (diagnostics + selection).
    observedAuthUrls.length = 0
    AUTH_URL_RE.lastIndex = 0
    let m
    while ((m = AUTH_URL_RE.exec(stderrBuffer)) !== null) {
      observedAuthUrls.push({ url: m[1], index: m.index })
    }
    if (selectedAuthUrl) return

    const markIdx = stderrBuffer.indexOf(RECOVERY_MARK)
    if (markIdx < 0) return
    const resetIdx = stderrBuffer.indexOf(AUTHCODE_RESET, markIdx)
    if (resetIdx < 0) return

    const recovery = observedAuthUrls.find((u) => u.index > resetIdx)
    if (recovery) {
      selectedAuthUrl = recovery.url
      selectedAuthUrlIndex = observedAuthUrls.indexOf(recovery)
      resolveAuthUrl(recovery.url)
    }
  }

  transport.stderr?.on('data', (d) => {
    stderrBuffer += d.toString()
    scanStderrForRecoveryUrl()
  })

  client = new Client({ name: 'midsession-286-harness', version: '0.0.0' }, { capabilities: {} })

  // Connect (initialize) — must succeed without OAuth.
  await client.connect(transport)
  const tools = await client.listTools()
  const toolNames = (tools.tools ?? []).map((t) => t.name)
  const connectOk = toolNames.includes('echo')
  console.log(`Connected without OAuth. tools=[${toolNames.join(', ')}]`)

  // Fire the protected tools/call WITHOUT awaiting: it stays pending until the 401 has
  // triggered OAuth recovery and mcp-remote retries it. Awaited further below.
  const nonce = `hello-286-${Date.now()}`
  const pendingCall = client.callTool({ name: 'echo', arguments: { text: nonce } }, undefined, { timeout: 15000 }).then(
    (result) => ({ resolved: true, result }),
    (err) => ({ resolved: false, err: err?.message ?? String(err) }),
  )

  // Wait (bounded) for the two observable signals: the 401 and the captured URL.
  const [, authUrl] = await Promise.all([
    waitFor(
      async () => {
        const s = await fetchState()
        return s.served401 >= 1 ? s : null
      },
      { timeoutMs: SIGNAL_TIMEOUT_MS, label: 'mid-session 401' },
    ),
    Promise.race([
      authUrlPromise,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for: post-recovery authorize URL')), SIGNAL_TIMEOUT_MS),
      ),
    ]),
  ])

  // Deliberately not logging the authorize URLs themselves: they carry state and the PKCE
  // code challenge. The count plus the selected index is enough to diagnose selection.
  console.log(`Authorization URLs observed: ${observedAuthUrls.length}; selected index (post-recovery): ${selectedAuthUrlIndex}`)

  // Complete the authorization headlessly: follow /authorize -> capture callback -> deliver code.
  const authRes = await fetch(authUrl, { redirect: 'manual' })
  const location = authRes.headers.get('location')
  if (!location) {
    throw new Error(`/authorize did not redirect (status=${authRes.status})`)
  }
  // mcp-remote's callback server binds 127.0.0.1; force that host so 'localhost' can't resolve
  // to ::1 and miss it on Windows.
  const callbackUrl = new URL(location)
  callbackUrl.hostname = '127.0.0.1'
  const cbRes = await fetch(callbackUrl)
  console.log(`Delivered authorization code to callback (status=${cbRes.status}).`)

  // mcp-remote now performs the /token exchange itself and retries the failed tools/call.
  const callOutcome = await pendingCall
  const echoText = callOutcome.resolved ? callOutcome.result?.content?.[0]?.text : undefined

  const debug = await fetchState()

  console.log('\n=== #286 MID-SESSION RE-AUTH ===\n')

  printResult('#286 connect + tools/list succeed without OAuth', connectOk, `tools=[${toolNames.join(', ')}]`)
  printResult('#286 mid-session 401 occurred', debug.served401 >= 1, `served401=${debug.served401}`)
  printResult('#286 /authorize reached', debug.authorizeHits >= 1, `authorizeHits=${debug.authorizeHits}`)
  printResult('#286 /token exchange completed', debug.tokenExchanged === true, `issuedTokens=${debug.issuedTokens}`)
  printResult(
    '#286 valid bearer observed by MCP endpoint',
    debug.bearerAcceptedForToolCall === true,
    `bearerAcceptedForToolCall=${debug.bearerAcceptedForToolCall}`,
  )
  printResult(
    '#286 original tools/call retried successfully',
    callOutcome.resolved === true,
    callOutcome.resolved ? 'resolved' : `err=${callOutcome.err}`,
  )
  printResult('#286 echo result matches nonce', echoText === nonce, `expected="${nonce}" got="${echoText ?? ''}"`)

  const passed =
    connectOk &&
    debug.served401 >= 1 &&
    debug.authorizeHits >= 1 &&
    debug.tokenExchanged === true &&
    debug.bearerAcceptedForToolCall === true &&
    callOutcome.resolved === true &&
    echoText === nonce

  if (!passed) {
    console.log('\n--- diagnostics ---')
    console.log(`authorization URLs observed: ${observedAuthUrls.length}, selected index: ${selectedAuthUrlIndex}`)
    console.log('debug/state:', JSON.stringify(debug, null, 2))
    console.log('proxy stderr (tail):')
    console.log(redactAuthUrls(stderrBuffer.split('\n').slice(-30).join('\n')))
  }

  console.log('\n================================')
  console.log(passed ? '#286 RESULT: PASS' : '#286 RESULT: FAIL')
  console.log('================================')

  return passed
}

function withDeadline(promise, ms) {
  let timer
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Overall deadline exceeded (${ms}ms)`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

process.on('SIGINT', async () => {
  console.log('\nInterrupted. Cleaning up...')
  await cleanup()
  process.exit(130)
})

withDeadline(run(), OVERALL_DEADLINE_MS)
  .then(async (passed) => {
    await cleanup()
    process.exitCode = passed ? 0 : 1
  })
  .catch(async (error) => {
    console.error('\nRunner failed:', error?.message ?? error)
    if (stderrBuffer.trim()) {
      console.log('proxy stderr (tail):')
      console.log(redactAuthUrls(stderrBuffer.split('\n').slice(-30).join('\n')))
    }
    await cleanup()
    process.exitCode = 1
  })

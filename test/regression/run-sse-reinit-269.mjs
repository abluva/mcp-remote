import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * Issue #269 external regression: real EventSource reconnect + endpoint rotation
 * detection + automatic `initialize` replay on the rotated SSE session.
 *
 * Regression scope (what this test proves):
 *  - A real SDK EventSource reconnect against a real server actually rotates the
 *    MCP session (S1 -> S2).
 *  - mcp-remote's ReinitAware SSE layer detects the rotation and REPLAYS
 *    `initialize` on the new session on its own, even though the client called
 *    connect() exactly once.
 *  - A tools/call issued after the replay succeeds on the rotated session.
 *
 * NOT in scope for this first (deterministic) version: request-gating / ordering
 * of a tool call that arrives *during* an in-flight reinit. The harness waits until
 * S2 is initialized before issuing tools/call, so it does not exercise that race.
 * That ordering is already covered by the repo unit tests
 * (utils.test.ts, "Feature: Legacy SSE session recovery (issue #269)").
 */

const regressionDir = dirname(fileURLToPath(import.meta.url))
const repoDir = process.env.MCP_REMOTE_BASE_PATH ?? join(regressionDir, '..', '..')
const proxyPath = join(repoDir, 'dist', 'proxy.js')
const fixtureRotatePath = join(regressionDir, 'fixture-sse-rotate.mjs')

const FIXTURE_PORT = 4002
const sseUrl = `http://127.0.0.1:${FIXTURE_PORT}/sse`
const debugStateUrl = `http://127.0.0.1:${FIXTURE_PORT}/debug/state`

const OVERALL_DEADLINE_MS = 30000
const S2_READY_TIMEOUT_MS = 20000

// -----------------------------------------------------
// Small utilities
// -----------------------------------------------------

function isPortInUse(port, host = '127.0.0.1') {
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

function waitForPort(port, host = '127.0.0.1', timeoutMs = 10000) {
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
          reject(new Error(`Timed out waiting for ${host}:${port}`))
          return
        }
        setTimeout(tryConnect, 150)
      })
    }
    tryConnect()
  })
}

async function waitFor(predicate, { timeoutMs, intervalMs = 100, label }) {
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

// -----------------------------------------------------
// Main
// -----------------------------------------------------

let fixtureChild = null
let client = null
let transport = null
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
}

async function run() {
  console.log('mcp-remote #269 SSE reinitialize regression')
  console.log(`Node: ${process.version}`)
  console.log(`Proxy: ${proxyPath}`)

  if (!existsSync(proxyPath)) {
    throw new Error(`mcp-remote proxy not found: ${proxyPath}`)
  }
  if (!existsSync(fixtureRotatePath)) {
    throw new Error(`Rotating SSE fixture not found: ${fixtureRotatePath}`)
  }

  console.log('\nChecking fixture port...')
  if (await isPortInUse(FIXTURE_PORT)) {
    throw new Error(`Fixture port ${FIXTURE_PORT} already in use. Stop the existing process before running.`)
  }

  // Start the rotating SSE fixture.
  fixtureChild = spawn(process.execPath, [fixtureRotatePath], {
    cwd: regressionDir,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  console.log('Fixture is ready.')

  // Spawn the REAL built proxy over stdio and keep ONE session alive.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [proxyPath, sseUrl, '--transport', 'sse-only'],
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (d) => {
    stderrBuffer += d.toString()
  })

  client = new Client({ name: 'reinit-269-harness', version: '0.0.0' }, { capabilities: {} })

  // Single initialize on S1.
  await client.connect(transport)
  console.log('\nClient connected (initialize on S1).')

  // Readiness gate (no sleep): wait until the ROTATED session S2 exists AND has
  // received initialize — i.e. mcp-remote replayed the handshake on its own.
  console.log('Waiting for rotated session S2 to be initialized by replay...')
  await waitFor(
    async () => {
      const { sessions } = await fetchState()
      const s2 = sessions.find((s) => s.ordinal === 2)
      return s2 && s2.initialized ? s2 : null
    },
    { timeoutMs: S2_READY_TIMEOUT_MS, intervalMs: 100, label: 'S2 initialized' },
  )
  console.log('S2 is initialized (replay observed).')

  // Issue the tool call after replay is confirmed.
  const nonce = `hello-269-${Date.now()}`
  const result = await client.callTool({
    name: 'echo',
    arguments: { text: nonce },
  })
  const echoed = result?.content?.[0]?.text

  const { sessions } = await fetchState()
  const s2 = sessions.find((s) => s.ordinal === 2)

  console.log('\n=== #269 SSE REINITIALIZE ===\n')

  // Assertion 1: S2 was actually created (a real reconnect rotated the session).
  const rotated = sessions.length >= 2 && !!s2
  printResult('#269 SSE session rotated (S2 created)', rotated, `sessions=${sessions.length}`)

  // Assertion 2: S2 received initialize even though the client called connect() once.
  const replayed = !!s2 && s2.methods.includes('initialize')
  printResult('#269 initialize replayed on rotated session', replayed, s2 ? `S2.methods=[${s2.methods.join(', ')}]` : 'no S2')

  // Assertion 3: tools/call succeeded on S2 after replay.
  const toolReachedS2 = !!s2 && s2.methods.includes('tools/call')
  printResult('#269 tools/call succeeds on rotated session', toolReachedS2 && echoed !== undefined, `echoedDefined=${echoed !== undefined}`)

  // Assertion 4: the echoed text matches the nonce.
  const echoMatches = echoed === nonce
  printResult('#269 echo result matches nonce', echoMatches, `expected="${nonce}" got="${echoed ?? ''}"`)

  const passed = rotated && replayed && toolReachedS2 && echoMatches

  if (!passed) {
    console.log('\n--- diagnostics ---')
    console.log('debug/state:', JSON.stringify(sessions, null, 2))
    if (stderrBuffer.trim()) {
      console.log('proxy stderr (tail):')
      console.log(stderrBuffer.split('\n').slice(-25).join('\n'))
    }
  }

  console.log('\n================================')
  console.log(passed ? '#269 RESULT: PASS' : '#269 RESULT: FAIL')
  console.log('================================')

  return passed
}

// Overall deadline guard so the run can never hang on a missing signal.
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
      console.log(stderrBuffer.split('\n').slice(-25).join('\n'))
    }
    await cleanup()
    process.exitCode = 1
  })

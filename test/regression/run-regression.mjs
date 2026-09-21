import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import net from 'node:net'

const regressionDir = dirname(fileURLToPath(import.meta.url))

const repoDir = process.env.MCP_REMOTE_BASE_PATH ?? join(regressionDir, '..', '..')

const proxyPath = join(repoDir, 'dist', 'proxy.js')

const httpFixturePath = join(regressionDir, 'fixture-http.mjs')

const sseFixturePath = join(regressionDir, 'fixture-sse.mjs')

const httpUrl = 'http://127.0.0.1:4000/mcp'

const sseUrl = 'http://127.0.0.1:4001/sse'

const nodeExecutable = process.execPath

const require = createRequire(import.meta.url)
const inspectorLauncher = require.resolve('@modelcontextprotocol/inspector/clients/launcher/build/index.js')
// Read from the installed dependency so the log can never claim a different version.
const inspectorVersion = require('@modelcontextprotocol/inspector/package.json').version

const fixtureProcesses = []

// -----------------------------------------------------
// Check whether a port is already occupied
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

// -----------------------------------------------------
// Refuse to run if fixture ports are already occupied
// -----------------------------------------------------

async function ensureFixturePortsAreFree() {
  const httpBusy = await isPortInUse(4000)

  const sseBusy = await isPortInUse(4001)

  const busyPorts = []

  if (httpBusy) {
    busyPorts.push('4000 (HTTP fixture)')
  }

  if (sseBusy) {
    busyPorts.push('4001 (SSE fixture)')
  }

  if (busyPorts.length > 0) {
    throw new Error(
      `Fixture port already in use: ${busyPorts.join(', ')}. Stop the existing fixture/process before running the regression suite.`,
    )
  }
}

// -----------------------------------------------------
// Wait until a fixture port becomes ready
// -----------------------------------------------------

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

        setTimeout(tryConnect, 200)
      })
    }

    tryConnect()
  })
}

// -----------------------------------------------------
// Start fixture
// -----------------------------------------------------

function startFixture(name, fixturePath) {
  console.log(`Starting ${name} fixture...`)

  const child = spawn(nodeExecutable, [fixturePath], {
    cwd: regressionDir,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  fixtureProcesses.push({
    name,
    child,
  })

  child.stdout.on('data', (data) => {
    const text = data.toString().trim()

    if (text) {
      console.log(`[${name} fixture] ${text}`)
    }
  })

  child.stderr.on('data', (data) => {
    const text = data.toString().trim()

    if (text) {
      console.error(`[${name} fixture stderr] ${text}`)
    }
  })

  child.on('error', (error) => {
    console.error(`${name} fixture process error:`, error)
  })

  return child
}

// -----------------------------------------------------
// Stop fixture
// -----------------------------------------------------

function stopFixture({ name, child }) {
  if (!child || child.exitCode !== null || child.killed) {
    return
  }

  console.log(`Stopping ${name} fixture...`)

  child.kill()
}

function stopAllFixtures() {
  for (const fixture of fixtureProcesses) {
    stopFixture(fixture)
  }
}

// -----------------------------------------------------
// Run Inspector through Abluva mcp-remote
// -----------------------------------------------------

function runInspector({ remoteUrl, remoteTransport, proxyArgs = [], args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      nodeExecutable,
      [
        inspectorLauncher,
        '--cli',

        'node',
        proxyPath,
        remoteUrl,
        '--transport',
        remoteTransport,

        ...proxyArgs,

        '--',

        ...args,

        '--format',
        'json',
        '--connect-timeout',
        '30000',
      ],
      {
        shell: false,
        windowsHide: true,
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  })
}

// -----------------------------------------------------
// Output helpers
// -----------------------------------------------------

function printResult(name, passed, details = '') {
  console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}`)

  if (details) {
    console.log(`  ${details}`)
  }
}

function printFailureDetails(result) {
  if (result.stdout) {
    console.log('  stdout:')

    console.log(result.stdout)
  }

  if (result.stderr) {
    console.log('  stderr:')

    console.log(result.stderr)
  }
}

// -----------------------------------------------------
// Detect known SSE cleanup warnings
// -----------------------------------------------------

function detectCleanupIssues(results) {
  const combinedStderr = results.map((result) => result.stderr).join('\n')

  const issues = []

  if (combinedStderr.includes('UV_HANDLE_CLOSING')) {
    issues.push('UV_HANDLE_CLOSING assertion')
  }

  if (combinedStderr.includes('AbortError')) {
    issues.push('AbortError during shutdown')
  }

  return issues
}

// -----------------------------------------------------
// HTTP checks
// -----------------------------------------------------

async function runHttpChecks() {
  console.log('\n=== STREAMABLE HTTP ===\n')

  const initialize = await runInspector({
    remoteUrl: httpUrl,
    remoteTransport: 'http-only',
    args: ['--method', 'initialize'],
  })

  const initializePass = initialize.code === 0 && initialize.stdout.includes('mcp-remote-regression-fixture')

  printResult('HTTP initialize', initializePass, `exit=${initialize.code}`)

  if (!initializePass) {
    printFailureDetails(initialize)
  }

  const toolsList = await runInspector({
    remoteUrl: httpUrl,
    remoteTransport: 'http-only',
    args: ['--method', 'tools/list'],
  })

  const toolsListPass = toolsList.code === 0 && toolsList.stdout.includes('"name":"echo"')

  printResult('HTTP tools/list', toolsListPass, `exit=${toolsList.code}`)

  if (!toolsListPass) {
    printFailureDetails(toolsList)
  }

  const expectedText = 'hello-from-http-automation'

  const toolsCall = await runInspector({
    remoteUrl: httpUrl,
    remoteTransport: 'http-only',
    args: ['--method', 'tools/call', '--tool-name', 'echo', '--tool-arg', `text=${expectedText}`],
  })

  const toolsCallPass = toolsCall.code === 0 && toolsCall.stdout.includes(expectedText)

  printResult('HTTP tools/call', toolsCallPass, `exit=${toolsCall.code}`)

  if (!toolsCallPass) {
    printFailureDetails(toolsCall)
  }

  return {
    passed: initializePass && toolsListPass && toolsCallPass,

    results: [initialize, toolsList, toolsCall],
  }
}

// -----------------------------------------------------
// SSE checks
// -----------------------------------------------------

async function runSseChecks() {
  console.log('\n=== LEGACY SSE ===\n')

  const initialize = await runInspector({
    remoteUrl: sseUrl,
    remoteTransport: 'sse-only',
    args: ['--method', 'initialize'],
  })

  const initializePass = initialize.code === 0 && initialize.stdout.includes('mcp-remote-regression-sse-fixture')

  printResult('SSE initialize', initializePass, `exit=${initialize.code}`)

  if (!initializePass) {
    printFailureDetails(initialize)
  }

  const toolsList = await runInspector({
    remoteUrl: sseUrl,
    remoteTransport: 'sse-only',
    args: ['--method', 'tools/list'],
  })

  const toolsListPass = toolsList.code === 0 && toolsList.stdout.includes('"name":"echo"')

  printResult('SSE tools/list', toolsListPass, `exit=${toolsList.code}`)

  if (!toolsListPass) {
    printFailureDetails(toolsList)
  }

  const expectedText = 'hello-from-sse-automation'

  const toolsCall = await runInspector({
    remoteUrl: sseUrl,
    remoteTransport: 'sse-only',
    args: ['--method', 'tools/call', '--tool-name', 'echo', '--tool-arg', `text=${expectedText}`],
  })

  const toolsCallPass = toolsCall.code === 0 && toolsCall.stdout.includes(expectedText)

  printResult('SSE tools/call', toolsCallPass, `exit=${toolsCall.code}`)

  if (!toolsCallPass) {
    printFailureDetails(toolsCall)
  }

  const results = [initialize, toolsList, toolsCall]

  const cleanupIssues = detectCleanupIssues(results)

  console.log('')

  if (cleanupIssues.length === 0) {
    console.log('CLEAN - SSE shutdown/cleanup')
  } else {
    console.log('WARN - SSE shutdown/cleanup')

    for (const issue of cleanupIssues) {
      console.log(`  ${issue}`)
    }
  }

  return {
    passed: initializePass && toolsListPass && toolsCallPass,

    cleanupIssues,
    results,
  }
}

// -----------------------------------------------------
// #268 historical regression:
// custom header NAME is logged, but the VALUE is never
// leaked to stderr. Runs the real built dist/proxy.js
// against the local HTTP fixture (no auth needed).
// -----------------------------------------------------

const ISSUE_268_HEADER_NAME = 'X-Abluva-Agent-Key'
const ISSUE_268_HEADER_SECRET = 'SEKRET-sentinel-abc123'

async function runIssue268Check() {
  console.log('\n=== #268 CUSTOM HEADER LOGGING ===\n')

  const initialize = await runInspector({
    remoteUrl: httpUrl,
    remoteTransport: 'http-only',
    proxyArgs: ['--header', `${ISSUE_268_HEADER_NAME}: ${ISSUE_268_HEADER_SECRET}`],
    args: ['--method', 'initialize'],
  })

  const initializePass = initialize.code === 0 && initialize.stdout.includes('mcp-remote-regression-fixture')

  printResult('#268 initialize succeeds', initializePass, `exit=${initialize.code}`)

  const nameLogged = initialize.stderr.includes(`Using custom header names: ${ISSUE_268_HEADER_NAME}`)

  printResult('#268 custom header name logged', nameLogged)

  const valueLeaked = initialize.stderr.includes(ISSUE_268_HEADER_SECRET)

  printResult('#268 custom header value not leaked', !valueLeaked)

  if (!initializePass || !nameLogged || valueLeaked) {
    printFailureDetails(initialize)
  }

  return {
    passed: initializePass && nameLogged && !valueLeaked,

    result: initialize,
  }
}

// -----------------------------------------------------
// Main
// -----------------------------------------------------

async function main() {
  console.log('mcp-remote automated regression runner')

  console.log(`Node: ${process.version}`)

  console.log(`Node executable: ${nodeExecutable}`)

  console.log(`Inspector: local @modelcontextprotocol/inspector@${inspectorVersion}`)

  if (!existsSync(proxyPath)) {
    throw new Error(`mcp-remote proxy not found: ${proxyPath}`)
  }

  if (!existsSync(httpFixturePath)) {
    throw new Error(`HTTP fixture not found: ${httpFixturePath}`)
  }

  if (!existsSync(sseFixturePath)) {
    throw new Error(`SSE fixture not found: ${sseFixturePath}`)
  }

  // Important hardening:
  // refuse to reuse old fixture processes.
  console.log('\nChecking fixture ports...')

  await ensureFixturePortsAreFree()

  console.log('Fixture ports are free.')

  try {
    startFixture('HTTP', httpFixturePath)

    startFixture('SSE', sseFixturePath)

    console.log('\nWaiting for fixtures...')

    await Promise.all([waitForPort(4000), waitForPort(4001)])

    console.log('Fixtures are ready.')

    const http = await runHttpChecks()

    const sse = await runSseChecks()

    const issue268 = await runIssue268Check()

    const functionalPass = http.passed && sse.passed && issue268.passed

    console.log('\n================================')

    console.log(functionalPass ? 'OVERALL FUNCTIONAL RESULT: PASS' : 'OVERALL FUNCTIONAL RESULT: FAIL')

    if (sse.cleanupIssues.length > 0) {
      console.log('SSE CLEANUP RESULT: WARN - tracked separately')
    } else {
      console.log('SSE CLEANUP RESULT: CLEAN')
    }

    console.log('================================')

    process.exitCode = functionalPass ? 0 : 1
  } finally {
    console.log('\nCleaning up fixtures...')

    stopAllFixtures()
  }
}

process.on('SIGINT', () => {
  console.log('\nInterrupted. Cleaning up fixtures...')

  stopAllFixtures()

  process.exit(130)
})

main().catch((error) => {
  console.error('\nRunner failed:', error.message ?? error)

  stopAllFixtures()

  process.exitCode = 1
})

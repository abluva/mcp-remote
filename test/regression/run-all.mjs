import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Aggregate runner for the mcp-remote regression scripts.
 *
 * Runs each script sequentially with process.execPath, streaming its output live.
 * A failing script does NOT stop the others; every script runs. At the end it prints
 * a PASS/FAIL summary and exits 1 if any script failed, else 0.
 */

// Derive the directory from this file's location so the runner is portable.
const regressionDir = dirname(fileURLToPath(import.meta.url))

const scripts = ['run-regression.mjs', 'run-sse-reinit-269.mjs', 'run-oauth-midsession-286.mjs']

function runScript(scriptName) {
  return new Promise((resolve) => {
    const scriptPath = join(regressionDir, scriptName)

    console.log(`\n========================================`)
    console.log(`RUNNING: ${scriptName}`)
    console.log(`========================================\n`)

    if (!existsSync(scriptPath)) {
      console.error(`Script not found: ${scriptPath}`)
      resolve({ scriptName, code: null, missing: true })
      return
    }

    const child = spawn(process.execPath, [scriptPath], {
      cwd: regressionDir,
      shell: false,
      windowsHide: true,
      stdio: 'inherit', // stream child stdout/stderr straight to this terminal
    })

    child.on('error', (error) => {
      console.error(`Failed to start ${scriptName}:`, error.message ?? error)
      resolve({ scriptName, code: null, error: error.message ?? String(error) })
    })

    child.on('close', (code) => {
      console.log(`\n---- ${scriptName} exited with code ${code} ----`)
      resolve({ scriptName, code })
    })
  })
}

async function main() {
  console.log('mcp-remote aggregate regression runner')
  console.log(`Node: ${process.version}`)
  console.log(`Scripts: ${scripts.join(', ')}`)

  const results = []
  for (const scriptName of scripts) {
    // Sequential: await each before starting the next (fixtures share ports).
    const result = await runScript(scriptName)
    results.push(result)
  }

  console.log(`\n========================================`)
  console.log(`SUMMARY`)
  console.log(`========================================`)

  let anyFailed = false
  for (const { scriptName, code, missing, error } of results) {
    const passed = code === 0
    if (!passed) anyFailed = true
    let detail = `exit=${code}`
    if (missing) detail = 'not found'
    else if (error) detail = `error: ${error}`
    console.log(`${passed ? 'PASS' : 'FAIL'} - ${scriptName}  (${detail})`)
  }

  console.log(`========================================`)
  console.log(anyFailed ? 'OVERALL: FAIL' : 'OVERALL: PASS')
  console.log(`========================================`)

  process.exitCode = anyFailed ? 1 : 0
}

main().catch((error) => {
  console.error('\nAggregate runner failed:', error?.message ?? error)
  process.exitCode = 1
})

// Starts Page Studio locally: the backend Worker (API on :8787) and the Angular app (:3002),
// which forwards /api to the Worker. Stop both with Ctrl+C.
import { spawn } from 'node:child_process'

const processes = [
  { name: 'backend', command: 'pnpm exec wrangler dev --port 8787 --local' },
  { name: 'frontend', command: 'pnpm --filter @spsedu360/web-builder dev' },
].map(({ name, command }) => {
  const child = spawn(command, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n') + '\n'
  child.stdout.on('data', (chunk) => process.stdout.write(prefix(chunk)))
  child.stderr.on('data', (chunk) => process.stderr.write(prefix(chunk)))
  child.on('exit', (code) => {
    console.log(
      `[${name}] stopped (${code ?? 'signal'}); stopping the other one too.`,
    )
    shutdown(code ?? 0)
  })
  return child
})

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const child of processes) if (child.exitCode === null) child.kill()
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

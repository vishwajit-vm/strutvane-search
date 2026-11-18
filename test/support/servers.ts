/**
 * Throwaway Meilisearch and Typesense servers for the real-server suites.
 *
 * Each suite starts its own container with a unique name (`strutvane-search-test-<engine>-<pid>-
 * <random>`), bound to a random loopback port, and removes it afterwards (`docker rm -f`), so
 * suites never share state and never touch containers they didn't start. When Docker is missing
 * or can't run Linux containers, the suite is skipped with the reason.
 *
 * Images are pinned: Meilisearch v1.57.0 and Typesense 30.2.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A running test server. */
export interface TestServer {
  readonly url: string
  readonly key: string
  stop(): Promise<void>
}

/** Pinned images. */
export const IMAGES = {
  meilisearch: 'getmeili/meilisearch:v1.57.0',
  typesense: 'typesense/typesense:30.2',
} as const

let checked: Promise<string | undefined> | undefined

/** Why the real-server suites can't run here, or `undefined` when they can. */
export function dockerUnavailable(): Promise<string | undefined> {
  checked ??= (async () => {
    if (process.env['SEARCH_SKIP_SERVERS'] === '1') return 'SEARCH_SKIP_SERVERS=1'
    try {
      const { stdout } = await run('docker', ['info', '--format', '{{.OSType}}'], {
        timeout: 20_000,
      })
      return stdout.trim() === 'linux'
        ? undefined
        : `Docker runs ${stdout.trim()} containers, not Linux`
    } catch {
      return 'Docker is not available'
    }
  })()
  return checked
}

async function start(
  engine: keyof typeof IMAGES,
  containerPort: number,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
  ready: (url: string, key: string) => Promise<boolean>,
): Promise<TestServer> {
  const name = `strutvane-search-test-${engine}-${process.pid}-${randomBytes(4).toString('hex')}`
  const key = env['MEILI_MASTER_KEY'] ?? env['TYPESENSE_API_KEY'] ?? ''
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await run(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-p',
      `127.0.0.1::${containerPort}`,
      ...envArgs,
      IMAGES[engine],
      ...args,
    ],
    { timeout: 300_000 },
  )
  const stop = async (): Promise<void> => {
    await run('docker', ['rm', '-f', name], { timeout: 60_000 }).catch(() => undefined)
  }
  try {
    const { stdout } = await run('docker', ['port', name, `${containerPort}/tcp`], {
      timeout: 20_000,
    })
    const port = /:(\d+)\s*$/m.exec(stdout.trim())?.[1]
    if (port === undefined) throw new Error(`docker port gave no port: ${stdout}`)
    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 90_000
    while (!(await ready(url, key).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`${engine} did not become ready in 90 s`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { url, key, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

/** Start a Meilisearch server with a random master key. */
export function startMeilisearch(): Promise<TestServer> {
  return start(
    'meilisearch',
    7700,
    {
      MEILI_MASTER_KEY: randomBytes(16).toString('hex'),
      MEILI_NO_ANALYTICS: 'true',
      MEILI_ENV: 'development',
    },
    [],
    async (url) => (await fetch(`${url}/health`)).ok,
  )
}

/** Start a Typesense server with a random API key. */
export function startTypesense(): Promise<TestServer> {
  const key = randomBytes(16).toString('hex')
  return start(
    'typesense',
    8108,
    { TYPESENSE_API_KEY: key, TYPESENSE_DATA_DIR: '/tmp' },
    ['--data-dir', '/tmp', '--api-key', key, '--enable-cors'],
    async (url) => {
      const response = await fetch(`${url}/health`)
      return response.ok && ((await response.json()) as { ok?: boolean }).ok === true
    },
  )
}

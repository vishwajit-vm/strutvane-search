/**
 * The installer: on a skeleton-shaped app it writes config/search.ts, registers it and the
 * provider, adds the .env keys of the chosen engine (secrets empty), is idempotent, refuses to
 * guess on unknown file shapes, and uninstall reverses it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkIdempotent, runInstaller } from '@strutvane/framework/devkit'
import { afterEach, describe, expect, test } from 'vitest'
import { addConfigKey, addProvider, removeConfigKey, removeProvider } from '../src/install/patch.ts'
import { CONFIG_TEMPLATE, chosenEngine, INSTALL_PATHS, installer } from '../src/installer.ts'

const PROVIDERS = `// The service providers that run at boot.
import type { AnyProvider } from '@strutvane/framework'
import { AppServiceProvider } from '../app/providers/app.provider.ts'

const providers: readonly AnyProvider[] = [AppServiceProvider]

export default providers
`
const CONFIG_INDEX = `import type { ConfigFiles } from '@strutvane/framework'
import app from './app.ts'
import logging from './logging.ts'

export default { app, logging } satisfies ConfigFiles
`

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-search-install-'))
  folders.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8')

const skeleton = () =>
  project({
    'bootstrap/providers.ts': PROVIDERS,
    'config/index.ts': CONFIG_INDEX,
    '.env': 'APP_NAME=Blog\n',
    '.env.example': 'APP_NAME=\n',
  })

describe('the installer', () => {
  test('installs search completely on a skeleton app (meilisearch by default)', async () => {
    const root = skeleton()
    const result = await runInstaller(installer, { projectRoot: root })
    expect(result.committed).toBe(true)
    expect(read(root, INSTALL_PATHS.config)).toBe(CONFIG_TEMPLATE)
    expect(read(root, 'bootstrap/providers.ts')).toContain(
      "import SearchServiceProvider from '@strutvane/search/provider'",
    )
    expect(read(root, 'bootstrap/providers.ts')).toContain(
      '[AppServiceProvider, SearchServiceProvider]',
    )
    expect(read(root, 'config/index.ts')).toContain("import search from './search.ts'")
    expect(read(root, 'config/index.ts')).toContain('{ app, logging, search }')
    const env = read(root, '.env')
    expect(env).toContain('SEARCH_DRIVER=meilisearch')
    expect(env).toContain('MEILISEARCH_HOST=http://127.0.0.1:7700')
    expect(env).not.toContain('TYPESENSE_')
    expect(read(root, '.env.example')).toMatch(/MEILISEARCH_KEY=\s*(\n|$)/)
  })

  test('--engine typesense adds the Typesense keys', async () => {
    const root = skeleton()
    await runInstaller(installer, { projectRoot: root, answers: { engine: 'typesense' } })
    const env = read(root, '.env')
    expect(env).toContain('SEARCH_DRIVER=typesense')
    expect(env).toContain('TYPESENSE_PORT=8108')
    expect(env).not.toContain('MEILISEARCH_')
  })

  test('running it twice changes nothing the second time', async () => {
    const root = skeleton()
    const report = await checkIdempotent(installer, { projectRoot: root })
    // The changes a second run would still make: none.
    expect(report).toEqual([])
  })

  test('a dry run writes nothing', async () => {
    const root = skeleton()
    const result = await runInstaller(installer, { projectRoot: root, dryRun: true })
    expect(result.changes.length).toBeGreaterThan(0)
    expect(read(root, 'bootstrap/providers.ts')).toBe(PROVIDERS)
  })

  test('an existing config/search.ts is kept', async () => {
    const root = project({ ...{ 'config/search.ts': 'export default {}\n' } })
    const result = await runInstaller(installer, {
      projectRoot: root,
      answers: { engine: 'database' },
    })
    expect(read(root, 'config/search.ts')).toBe('export default {}\n')
    expect(result.messages.map((m) => m.message).join('\n')).toMatch(
      /config\/index.ts was not found[\s\S]*Neither bootstrap\/providers.ts/,
    )
  })

  test('unknown file shapes are never guessed at', async () => {
    const root = project({
      'bootstrap/providers.ts': 'export default [A, B]\n',
      'config/index.ts': 'export default build()\n',
    })
    const result = await runInstaller(installer, { projectRoot: root })
    expect(read(root, 'bootstrap/providers.ts')).toBe('export default [A, B]\n')
    expect(read(root, 'config/index.ts')).toBe('export default build()\n')
    expect(result.messages.filter((m) => m.level === 'warn')).toHaveLength(2)
  })

  test('uninstall reverses the edits and keeps config/search.ts', async () => {
    const root = skeleton()
    await runInstaller(installer, { projectRoot: root })
    await runInstaller(installer, { projectRoot: root, mode: 'uninstall' })
    expect(read(root, 'bootstrap/providers.ts')).toBe(PROVIDERS)
    expect(read(root, 'config/index.ts')).toBe(CONFIG_INDEX)
    expect(read(root, '.env')).not.toContain('SEARCH_DRIVER')
    expect(read(root, INSTALL_PATHS.config)).toBe(CONFIG_TEMPLATE)
    const bare = project({})
    const nothing = await runInstaller(installer, { projectRoot: bare, mode: 'uninstall' })
    expect(nothing.changes).toEqual([])
  })

  test('an older app with strutvane.config.ts gets the provider through the config patcher', async () => {
    const root = project({ 'strutvane.config.ts': 'export default { providers: [] }\n' })
    await runInstaller(installer, { projectRoot: root, answers: { engine: 'database' } })
    expect(read(root, 'strutvane.config.ts')).toContain('@strutvane/search/provider')
    await runInstaller(installer, { projectRoot: root, mode: 'uninstall' })
    expect(read(root, 'strutvane.config.ts')).not.toContain('@strutvane/search/provider')
  })

  test('--engine is validated', () => {
    expect(chosenEngine({})).toBe('meilisearch')
    expect(chosenEngine({ engine: true })).toBe('meilisearch')
    expect(chosenEngine({ engine: 'database' })).toBe('database')
    expect(() => chosenEngine({ engine: 'elastic' })).toThrow(/--engine/)
  })
})

describe('the source edits', () => {
  test.each([
    ['inline', 'const providers = [A]\n'],
    ['trailing comma', 'const providers = [A,]\n'],
    ['multi-line', 'const providers = [\n  A,\n  B,\n]\n'],
    ['multi-line without trailing comma', 'const providers = [\n  A,\n  B\n]\n'],
    ['empty', 'const providers = []\n'],
    ['empty multi-line', 'const providers = [\n]\n'],
  ])('providers (%s): add is idempotent and remove restores the file', (_shape, source) => {
    const added = addProvider(source) ?? ''
    expect(added).toContain('SearchServiceProvider')
    expect(addProvider(added)).toBe(added)
    expect(removeProvider(added)).toBe(source)
    expect(removeProvider(source)).toBe(source)
  })

  test.each([
    ['inline', 'export default { app }\n'],
    ['multi-line', 'export default {\n  app,\n  logging,\n}\n'],
  ])('config index (%s): add is idempotent and remove restores the file', (_shape, source) => {
    const added = addConfigKey(source) ?? ''
    expect(added).toContain("import search from './search.ts'")
    expect(addConfigKey(added)).toBe(added)
    expect(removeConfigKey(added)).toBe(source)
    expect(removeConfigKey(source)).toBe(source)
  })

  test('two arrays or objects are an unknown shape', () => {
    expect(addProvider('const providers = [A]\nconst providers = [B]\n')).toBeUndefined()
    expect(addConfigKey('export default { a }\nexport default { b }\n')).toBeUndefined()
  })
})

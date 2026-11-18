/**
 * The contributed commands: model lookup only inside app/models (no traversal, no symlink out),
 * search:import and search:flush through a booted app, install:search through the installer, and
 * exit codes for usage and validation problems.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Application } from '@strutvane/framework'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import commands, {
  flushCommand,
  importCommand,
  installCommand,
  kebab,
  loadModel,
  pascal,
  type SearchCommandContext,
} from '../src/commands.ts'
import { DatabaseEngine, MemoryEngine, runWithSearch, SearchManager } from '../src/index.ts'
import { TENANT_A, useTestDatabase } from './support/database.ts'
import { Post, Project } from './support/models.ts'

useTestDatabase()

const MODELS = pathToFileURL(join(import.meta.dirname, 'support', 'models.ts')).href
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** An app folder whose app/models re-export the test models (same module instances). */
function appRoot(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-search-cmd-'))
  folders.push(root)
  mkdirSync(join(root, 'app', 'models'), { recursive: true })
  writeFileSync(join(root, 'app', 'models', 'post.ts'), `export { Post } from '${MODELS}'\n`)
  writeFileSync(
    join(root, 'app', 'models', 'project.ts'),
    `export { Project as default } from '${MODELS}'\n`,
  )
  writeFileSync(join(root, 'app', 'models', 'plain.ts'), 'export const Plain = 1\n')
  for (const [path, content] of Object.entries(extra)) writeFileSync(join(root, path), content)
  return root
}

interface Captured {
  readonly lines: string[]
  readonly ctx: SearchCommandContext
}

function context(
  root: string,
  args: Record<string, string> = {},
  flags: Record<string, string> = {},
  extraFlags: Record<string, string> = {},
): Captured {
  const lines: string[] = []
  const push = (text = '') => void lines.push(text)
  return {
    lines,
    ctx: {
      args,
      flags,
      extraFlags,
      globals: { dryRun: false },
      requireProject: () => ({ root, packageJson: { dependencies: { '@strutvane/search': '*' } } }),
      out: { line: push, success: push, info: push, warn: push },
    },
  }
}

let engine: MemoryEngine
let manager: SearchManager
let booted = 0
let shutDown = 0

/** A stand-in for loadApplication: an app that runs work with the test's search manager. */
const deps = {
  loadApp: async (): Promise<Application> =>
    ({
      state: 'booted',
      boot: async () => void booted++,
      run: <T>(work: () => T): T => runWithSearch(manager, work),
      shutdown: async () => void shutDown++,
    }) as unknown as Application,
}

beforeEach(() => {
  engine = new MemoryEngine()
  manager = new SearchManager({ engine })
  booted = 0
  shutDown = 0
})

describe('loadModel', () => {
  test('finds a searchable model by class or file name', async () => {
    const root = appRoot()
    expect(await loadModel(root, 'Post')).toBe(Post)
    expect(await loadModel(root, 'post')).toBe(Post)
    expect(await loadModel(root, 'Project')).toBe(Project)
  })

  test.each([
    ['../secrets', /not a model name/],
    ['..', /not a model name/],
    ['C:evil', /not a model name/],
    ['Missing', /No app[\\/]models[\\/]missing\.ts/],
    ['Plain', /exports no searchable model/],
  ])('%s is refused', async (name, message) => {
    await expect(loadModel(appRoot(), name)).rejects.toThrow(message)
  })

  test('an app without app/models is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sv-search-cmd-'))
    folders.push(root)
    await expect(loadModel(root, 'Post')).rejects.toThrow(/does not exist/)
  })

  test('a symlink pointing outside app/models is never imported', async (ctx) => {
    const root = appRoot()
    const outside = join(root, 'evil.ts')
    writeFileSync(outside, "throw new Error('imported!')\n")
    try {
      symlinkSync(outside, join(root, 'app', 'models', 'evil.ts'))
    } catch {
      ctx.skip('this machine cannot create symlinks (Windows without developer mode)')
    }
    await expect(loadModel(root, 'Evil')).rejects.toThrow(/outside/)
  })

  test('names convert between kebab and Pascal case', () => {
    expect(kebab('BlogPost')).toBe('blog-post')
    expect(kebab('HTTPLog')).toBe('http-log')
    expect(pascal('blog-post')).toBe('BlogPost')
    expect(pascal('blogPost')).toBe('BlogPost')
  })
})

describe('search:import and search:flush', () => {
  test('import fills the index inside a booted app, then shuts it down', async () => {
    await Post.forceCreate({ title: 'One', author_id: 1 })
    await Post.forceCreate({ title: 'Two', author_id: 1 })
    await engine.flush({ name: 'posts' } as never)
    const { ctx, lines } = context(appRoot(), { model: 'Post' }, { chunk: '1' })
    const outcome = await importCommand(deps).run(ctx)
    expect(outcome).toMatchObject({ data: { indexed: 2, applicable: true } })
    expect(engine.size({ name: 'posts' })).toBe(2)
    expect(lines.at(-1)).toMatch(/2 Post record\(s\) indexed/)
    expect([booted, shutDown]).toEqual([1, 1])
  })

  test('import of one tenant with --tenant', async () => {
    const root = appRoot()
    const { ctx } = context(root, { model: 'Project' }, { tenant: TENANT_A })
    expect(await importCommand(deps).run(ctx)).toMatchObject({ data: { indexed: 0 } })
  })

  test('the database engine has nothing to import', async () => {
    manager = new SearchManager({ engine: new DatabaseEngine() })
    const { ctx, lines } = context(appRoot(), { model: 'Post' })
    expect(await importCommand(deps).run(ctx)).toMatchObject({ data: { applicable: false } })
    expect(lines.join('\n')).toMatch(/no index to fill/)
  })

  test('flush empties the index', async () => {
    await Post.forceCreate({ title: 'Gone soon', author_id: 1 })
    const { ctx } = context(appRoot(), { model: 'Post' })
    await importCommand(deps).run(ctx)
    expect(engine.size({ name: 'posts' })).toBe(1)
    expect(await flushCommand(deps).run(ctx)).toMatchObject({ data: { flushed: 'Post' } })
    expect(engine.size({ name: 'posts' })).toBe(0)
  })

  test.each([
    [{}, {}, 2],
    [{ model: '../x' }, {}, 2],
    [{ model: 'Post' }, { tenant: 'not-a-uuid' }, 2],
    [{ model: 'Post' }, { chunk: '0' }, 2],
    [{ model: 'Post' }, { chunk: 'many' }, 2],
  ])('usage problems exit 2: %j %j', async (args, flags, exitCode) => {
    const { ctx } = context(appRoot(), args, flags)
    expect(await importCommand(deps).run(ctx)).toMatchObject({ exitCode })
  })

  test('a search error exits 3 (1 for an engine outage) with its code', async () => {
    const { ctx } = context(appRoot(), { model: 'Project' })
    const failing = {
      loadApp: async () =>
        ({
          ...(await deps.loadApp()),
          run: () => {
            throw Object.assign(new (class extends Error {})('x'), {})
          },
        }) as unknown as Application,
    }
    await expect(importCommand(failing).run(ctx)).rejects.toThrow('x')
    // Without an active tenant a tenant model imports every tenant; with a broken engine it fails.
    const broken = new MemoryEngine()
    broken.upsert = async () => {
      const { SearchError } = await import('../src/errors.ts')
      throw new SearchError('engine_failed', { engine: 'memory', action: 'index', detail: 'down' })
    }
    manager = new SearchManager({ engine: broken })
    await Post.forceCreate({ title: 'x', author_id: 1 })
    const post = context(appRoot(), { model: 'Post' })
    expect(await importCommand(deps).run(post.ctx)).toMatchObject({
      exitCode: 1,
      data: { code: 'engine_failed' },
    })
  })
})

describe('install:search', () => {
  test('runs the installer, previewable with --dry-run', async () => {
    const root = appRoot({ '.env': '' })
    const preview = context(root, {}, {}, { engine: 'database' })
    const dry = await installCommand().run({ ...preview.ctx, globals: { dryRun: true } })
    expect(dry).toMatchObject({ data: { dryRun: true } })
    const real = context(root, {}, {}, { engine: 'database' })
    const done = await installCommand().run(real.ctx)
    expect(done).toMatchObject({ data: { dryRun: false } })
    expect(real.lines.join('\n')).toMatch(/config[\\/]search\.ts/)
  })

  test('a bad --engine is a usage error', async () => {
    const { ctx } = context(appRoot(), {}, {}, { engine: 'elastic' })
    expect(await installCommand().run(ctx)).toMatchObject({ exitCode: 2 })
  })

  test('the module exports the three commands in the CLI shape', () => {
    expect(commands.map((command) => command.name)).toEqual([
      'search:import',
      'search:flush',
      'install:search',
    ])
    for (const command of commands)
      expect(command.name).toMatch(/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/)
  })
})

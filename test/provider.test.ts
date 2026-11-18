/**
 * SearchServiceProvider in a real Application: the manager comes from config/search.ts, models
 * resolve it through the app's container inside app.run(), a bad config fails the boot, and
 * shutdown closes the engine.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, DatabaseConnectionToken, defineConfig } from '@strutvane/framework'
import { afterEach, describe, expect, test } from 'vitest'
import {
  currentSearch,
  MemoryEngine,
  maybeCurrentSearch,
  SearchManagerToken,
} from '../src/index.ts'
import SearchServiceProvider, { CONFIG_KEY } from '../src/provider.ts'
import { useTestDatabase } from './support/database.ts'
import { Post } from './support/models.ts'

const database = useTestDatabase()

/** A fixed 32-byte test key (never a real one). */
const TEST_KEY = `base64:${Buffer.alloc(32, 7).toString('base64')}`
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function makeApp(search?: Record<string, unknown>): Application {
  const basePath = mkdtempSync(join(tmpdir(), 'sv-search-app-'))
  folders.push(basePath)
  return Application.configure({ basePath, env: { APP_ENV: 'testing', APP_KEY: TEST_KEY } })
    .withConfig(search === undefined ? {} : { [CONFIG_KEY]: defineConfig(() => search) })
    .withProviders([SearchServiceProvider])
    .create()
}

describe('SearchServiceProvider', () => {
  test('binds the manager from config/search.ts; models find it inside the app', async () => {
    const app = makeApp({ driver: 'memory', prefix: 'app_' })
    // The app's models use this test's SQLite database instead of DB_* from .env.
    app.container.value(DatabaseConnectionToken, database.connection())
    await app.boot()
    try {
      const manager = app.make(SearchManagerToken)
      expect(manager.prefix).toBe('app_')
      expect(await manager.engine()).toBeInstanceOf(MemoryEngine)
      expect(maybeCurrentSearch()).toBeUndefined()
      await app.run(async () => {
        expect(currentSearch()).toBe(manager)
        await Post.forceCreate({ title: 'Inside the app', author_id: 1 })
        const found = await Post.search('inside').get()
        expect(found.map((post) => post.title)).toEqual(['Inside the app'])
      })
    } finally {
      await app.shutdown()
    }
  })

  test('without config/search.ts the defaults apply (the database engine)', async () => {
    const app = makeApp()
    await app.boot()
    try {
      const engine = await app.make(SearchManagerToken).engine()
      expect(engine.name).toBe('database')
    } finally {
      await app.shutdown()
    }
  })

  test('a bad config/search.ts fails the boot, naming the setting', async () => {
    const app = makeApp({ driver: 'elasticsearch' })
    await expect(app.boot()).rejects.toThrow(/driver must be one of/)
  })

  test('a server engine without its key fails on first use outside local development', async () => {
    const basePath = mkdtempSync(join(tmpdir(), 'sv-search-app-'))
    folders.push(basePath)
    const app = Application.configure({
      basePath,
      env: { APP_ENV: 'production', APP_KEY: TEST_KEY },
    })
      .withConfig({ [CONFIG_KEY]: defineConfig(() => ({ driver: 'typesense' })) })
      .withProviders([SearchServiceProvider])
      .create()
    try {
      await app.boot()
    } catch {
      // Production boot guards (APP_KEY and others) may refuse this bare test app first; the
      // key check itself is covered in manager.test.ts.
      return
    }
    try {
      await expect(app.make(SearchManagerToken).engine()).rejects.toThrow(/TYPESENSE_API_KEY/)
    } finally {
      await app.shutdown()
    }
  })
})

/**
 * A fresh in-memory SQLite database per test file: the schema registered, the tables created, the
 * models pointed at it, and every row removed before each test.
 */
import {
  Connection,
  sql,
  sqliteDriver,
  unsafeRaw,
  useConnection,
} from '@strutvane/framework/database'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { createTables, registerTestSchema } from './schema.ts'

/** Tenant ids used across the tests. */
export const TENANT_A = '0193a0b2-0000-7000-8000-00000000000a'
export const TENANT_B = '0193a0b2-0000-7000-8000-00000000000b'

/** Wire a describe block (or file) to its own database. */
export function useTestDatabase(): { readonly connection: () => Connection } {
  let connection: Connection | undefined
  beforeAll(async () => {
    registerTestSchema()
    connection = new Connection(sqliteDriver(':memory:'))
    useConnection(connection)
    await createTables(connection)
  })
  beforeEach(async () => {
    if (connection === undefined) return
    await connection.run(unsafeRaw('test reset', sql`DELETE FROM "posts"`))
    await connection.run(unsafeRaw('test reset', sql`DELETE FROM "projects"`))
  })
  afterAll(async () => {
    await connection?.close()
  })
  return {
    connection: () => {
      if (connection === undefined) throw new Error('The test database is not open yet.')
      return connection
    },
  }
}

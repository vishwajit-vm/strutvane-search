/**
 * The test schema: what `node strut migrate` would leave in `.strutvane/schema.json`, plus the
 * SQLite DDL for it. Two tables:
 * - `posts`: a plain (global) table with every column kind search maps, and three hidden ones a
 *   search engine must never see: `api_token` (secret by name), `reset_code` (`.secret()`) and
 *   `internal_note` (`.hidden()`).
 * - `projects`: a tenant table (`t.tenant()`), for the isolation tests.
 */
import {
  type Connection,
  configureOrm,
  registerSchema,
  type SchemaSnapshot,
  sql,
  unsafeRaw,
} from '@strutvane/framework/database'

const timestamps = [
  { name: 'created_at', kind: 'timestamp', nullable: true },
  { name: 'updated_at', kind: 'timestamp', nullable: true },
] as const

/** The schema snapshot. */
export const snapshot: SchemaSnapshot = {
  version: 1,
  tables: {
    posts: {
      name: 'posts',
      global: true,
      columns: [
        { name: 'id', kind: 'id', nullable: false },
        { name: 'title', kind: 'string', nullable: false, length: 200 },
        { name: 'body', kind: 'text', nullable: true },
        { name: 'status', kind: 'enum', nullable: false, values: ['draft', 'published'] },
        { name: 'author_id', kind: 'integer', nullable: false },
        { name: 'views', kind: 'integer', nullable: false },
        { name: 'rating', kind: 'decimal', nullable: true, precision: 4, scale: 2 },
        { name: 'featured', kind: 'boolean', nullable: false },
        { name: 'published_on', kind: 'date', nullable: true },
        { name: 'meta', kind: 'json', nullable: true },
        { name: 'api_token', kind: 'string', nullable: true, length: 80 },
        { name: 'reset_code', kind: 'string', nullable: true, length: 80, secret: true },
        { name: 'internal_note', kind: 'text', nullable: true, hidden: true },
        ...timestamps,
        { name: 'deleted_at', kind: 'timestamp', nullable: true },
      ],
      indexes: [],
    },
    projects: {
      name: 'projects',
      columns: [
        { name: 'id', kind: 'uuid', nullable: false },
        { name: 'tenant_id', kind: 'uuid', nullable: false, tenant: true },
        { name: 'name', kind: 'string', nullable: false, length: 200 },
        { name: 'notes', kind: 'text', nullable: true },
        { name: 'budget', kind: 'decimal', nullable: true, precision: 12, scale: 2 },
        ...timestamps,
      ],
      indexes: [],
    },
  },
}

/** Register the schema with the ORM and turn tenancy on (column `tenant_id`). */
export function registerTestSchema(): void {
  registerSchema(snapshot)
  configureOrm({ tenancy: { column: 'tenant_id' }, preventLazyLoading: false })
}

/** Create the tables on a fresh SQLite connection. */
export async function createTables(connection: Connection): Promise<void> {
  await connection.run(
    unsafeRaw(
      'test setup',
      sql`CREATE TABLE "posts" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "title" VARCHAR(200) NOT NULL,
        "body" TEXT,
        "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
        "author_id" INTEGER NOT NULL,
        "views" INTEGER NOT NULL DEFAULT 0,
        "rating" NUMERIC,
        "featured" INTEGER NOT NULL DEFAULT 0,
        "published_on" DATE,
        "meta" TEXT,
        "api_token" VARCHAR(80),
        "reset_code" VARCHAR(80),
        "internal_note" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT
      )`,
    ),
  )
  await connection.run(
    unsafeRaw(
      'test setup',
      sql`CREATE TABLE "projects" (
        "id" CHAR(36) PRIMARY KEY NOT NULL,
        "tenant_id" CHAR(36) NOT NULL,
        "name" VARCHAR(200) NOT NULL,
        "notes" TEXT,
        "budget" NUMERIC,
        "created_at" TEXT,
        "updated_at" TEXT
      )`,
    ),
  )
}

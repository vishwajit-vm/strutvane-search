// The table types the generated `.strutvane/types/models.d.ts` would hold for the test schema
// (test/support/schema.ts). Hand-written so the tests stay standalone.
import type { JsonValue } from '@strutvane/framework/database'

/** A row of `posts`. */
export interface PostRow {
  id: number
  title: string
  body: string | null
  status: 'draft' | 'published'
  author_id: number
  views: number
  rating: string | null
  featured: boolean
  published_on: string | null
  meta: JsonValue | null
  api_token: string | null
  reset_code: string | null
  internal_note: string | null
  created_at: Date | null
  updated_at: Date | null
  deleted_at: Date | null
}

/** A row of `projects` (a tenant table). */
export interface ProjectRow {
  id: string
  tenant_id: string
  name: string
  notes: string | null
  budget: string | null
  created_at: Date | null
  updated_at: Date | null
}

type Insert<TRow, TOptional extends keyof TRow> = Omit<TRow, TOptional> &
  Partial<Pick<TRow, TOptional>>

type PostInsert = Insert<
  PostRow,
  | 'id'
  | 'body'
  | 'status'
  | 'views'
  | 'rating'
  | 'featured'
  | 'published_on'
  | 'meta'
  | 'api_token'
  | 'reset_code'
  | 'internal_note'
  | 'created_at'
  | 'updated_at'
  | 'deleted_at'
>
type ProjectInsert = Insert<
  ProjectRow,
  'id' | 'tenant_id' | 'notes' | 'budget' | 'created_at' | 'updated_at'
>

declare module '@strutvane/framework/database' {
  interface TableRegistry {
    posts: { row: PostRow; insert: PostInsert; update: Partial<PostInsert>; json: PostRow }
    projects: {
      row: ProjectRow
      insert: ProjectInsert
      update: Partial<ProjectInsert>
      json: ProjectRow
    }
  }
}

/**
 * Type-level tests: the Searchable options name the model's own columns, and results are typed as
 * the model. Misuse fails to compile.
 */
import { Model } from '@strutvane/framework/database'
import { expectTypeOf, test } from 'vitest'
import { Searchable, type SearchBuilder, type SearchPage } from '../src/index.ts'
import { Post } from './support/models.ts'

test('search results are typed as the model', () => {
  expectTypeOf(Post.search('x')).toEqualTypeOf<SearchBuilder<Post>>()
  expectTypeOf(Post.search('x').get()).resolves.toEqualTypeOf<Post[]>()
  expectTypeOf(Post.search('x').paginate()).resolves.toEqualTypeOf<SearchPage<Post>>()
})

test('options only accept real columns', () => {
  Searchable(Model('posts'), { searchable: ['title'], filterable: ['status'], sortable: ['views'] })
  // @ts-expect-error: "titel" is not a column of posts
  Searchable(Model('posts'), { searchable: ['titel'] })
  // @ts-expect-error: methods are not columns
  Searchable(Model('posts'), { searchable: ['save'] })
  // @ts-expect-error: `searchable` is required
  Searchable(Model('posts'), { filterable: ['status'] })
  Searchable(Model('posts'), {
    searchable: ['title'],
    shouldBeSearchable: (post) => {
      expectTypeOf(post.views).toEqualTypeOf<number>()
      return true
    },
  })
})

/** The searchable test models, declared the way an app declares them in app/models. */
import { Model } from '@strutvane/framework/database'
import { Searchable } from '../../src/index.ts'

/** A global (shared) model with every field type search maps. */
export class Post extends Searchable(
  Model('posts', {
    fillable: [
      'title',
      'body',
      'status',
      'author_id',
      'views',
      'rating',
      'featured',
      'published_on',
    ],
  }),
  {
    searchable: ['title', 'body'],
    filterable: ['status', 'author_id', 'views', 'rating', 'featured', 'published_on'],
    sortable: ['views', 'published_on', 'created_at', 'title'],
    perPage: 10,
    shouldBeSearchable: (post) => post.title !== 'never index me',
    policy: {
      view: (user, post) => user !== null && String(user.id) === String(post.author_id),
    },
  },
) {}

/** A tenant model (its table has `t.tenant()`). */
export class Project extends Searchable(
  Model('projects', { fillable: ['name', 'notes', 'budget'] }),
  {
    searchable: ['name', 'notes'],
    filterable: ['budget', 'name'],
    sortable: ['name'],
  },
) {}

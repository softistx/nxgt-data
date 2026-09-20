# @nxgt/meilisearch documentation

The [README](../README.md) is the short version: what the package is, and one
example per area. These pages are the long one.

| Page | Read it when |
| --- | --- |
| [guide/definition.md](guide/definition.md) | you are describing an index: its uid, its primary key, and the settings typed by your document |
| [guide/sync.md](guide/sync.md) | the server has to match the definition at startup, in CI, or after a settings change |
| [guide/documents.md](guide/documents.md) | you are writing documents in, or reading them back by id |
| [guide/search.md](guide/search.md) | you are searching: filters, sorts, facets, highlighting, pages |
| [guide/errors.md](guide/errors.md) | a task failed, a primary key does not match, or you want to know which errors are the SDK's |
| [troubleshooting.md](troubleshooting.md) | you have an error message and want the fix |
| [roadmap.md](roadmap.md) | you are wondering what is planned, shipped, or deliberately left out |

Every example is TypeScript, imports from `@nxgt/meilisearch`, and runs
against a Meilisearch 1.x server through the official `meilisearch` SDK,
whose client you create yourself.

The examples share one document type and one definition:

```ts
import { defineIndex } from '@nxgt/meilisearch';

export interface Movie {
	id: number;
	title: string;
	overview: string;
	year: number;
	rating: number;
	genres: string[];
	director: { name: string; country: string };
}

export const movies = defineIndex<Movie>()({
	uid: 'movies',
	primaryKey: 'id',
	settings: {
		searchableAttributes: ['title', 'overview', 'director.name'],
		filterableAttributes: ['genres', 'year', 'director.name'],
		sortableAttributes: ['year', 'rating'],
	},
});
```

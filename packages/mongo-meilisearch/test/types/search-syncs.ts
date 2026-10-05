// What a search syncs config refuses. Checked by `tsc --noEmit`, never run: a
// refusal that stops holding fails the typecheck on its unused directive.
//
// `SearchSyncsConfig` is three nested conditionals over an inferred `I`, the shape
// that silently lost refusals in `@nxgt/mongo`. These cases are what says it
// still refuses what it claims to.
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import { Meilisearch } from 'meilisearch';
import type { ObjectId } from 'mongodb';
import { createSearchSyncs } from '../../src';
import {
	type Article,
	articleIndex,
	authorIndex,
	toAuthorHit,
	toHit,
	type Wired,
} from '../fixtures';

declare const mongo: Wired;
const meili = new Meilisearch({ host: 'http://127.0.0.1:1' });
const articles = bindIndex(meili, articleIndex);
const authors = bindIndex(meili, authorIndex);

/** An index whose ids are not strings, so `toIndexId` stops being optional. */
const numbered = bindIndex(
	meili,
	defineIndex<{ n: number; title: string }>()({
		uid: 'numbered',
		primaryKey: 'n',
		settings: {},
	}),
);

// An inline transform is typed by both sides: the document by the collection
// the key names, the result by the index the entry carries.
createSearchSyncs(mongo, {
	articles: {
		index: articles,
		transform: (article) => {
			const id: ObjectId = article._id;
			const draft: boolean = article.draft;
			return draft ? null : { id: String(id), title: article.title };
		},
	},
	authors: {
		index: authors,
		transform: (author) => ({ id: String(author._id), name: author.name }),
	},
});

// A transform written for the other collection.
createSearchSyncs(mongo, {
	// @ts-expect-error `authors` documents have no `title`
	articles: { index: articles, transform: toAuthorHit },
});

// A transform that gives the wrong index's document.
createSearchSyncs(mongo, {
	articles: {
		index: articles,
		// @ts-expect-error `articleIndex` holds `title`, not `name`
		transform: (article: Article) => ({ id: String(article._id), name: 'x' }),
	},
});

// A field the collection does not hold, inside an inline transform.
createSearchSyncs(mongo, {
	articles: {
		index: articles,
		// @ts-expect-error `titel` is not a field of `articles`
		transform: (article) => ({ id: String(article._id), title: article.titel }),
	},
});

// @ts-expect-error `transform` is not optional
createSearchSyncs(mongo, { articles: { index: articles } });

// @ts-expect-error `index` is not optional
createSearchSyncs(mongo, { articles: { transform: toHit } });

createSearchSyncs(mongo, {
	articles: {
		index: articles,
		transform: toHit,
		// @ts-expect-error the option is `batchSize`
		batchSizes: 10,
	},
});

// An index whose ids are numbers: the id cannot be read off the document.
createSearchSyncs(mongo, {
	// @ts-expect-error `toIndexId` is required when the ids are not strings
	articles: {
		index: numbered,
		transform: (article: Article) => ({ n: 1, title: article.title }),
	},
});

// The same entry, with it.
createSearchSyncs(mongo, {
	articles: {
		index: numbered,
		transform: (article: Article) => ({ n: 1, title: article.title }),
		toIndexId: (id) => Number(String(id).slice(0, 8)),
	},
});

// A key the Mongo wires no collection for.
createSearchSyncs(mongo, {
	// @ts-expect-error the Mongo wires no `comments`
	comments: { index: articles, transform: toHit },
});

// A key that is a member of the driver's `Db`.
createSearchSyncs(mongo, {
	// @ts-expect-error `command` is the driver's, not a collection
	command: { index: articles, transform: toHit },
});

// `syncIndexes` reports under the config's keys, and takes the index's options.
const search = createSearchSyncs(mongo, {
	articles: { index: articles, transform: toHit },
});
void search.syncIndexes({ dryRun: true }).then((reports) => {
	const uid: string = reports.articles.uid;
	void uid;
	// @ts-expect-error `authors` is not a key of this config
	void reports.authors;
});
// @ts-expect-error the option is `dryRun`
void search.syncIndexes({ dryrun: true });

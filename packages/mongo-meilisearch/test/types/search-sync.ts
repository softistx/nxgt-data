// What createSearchSync refuses. Checked by `tsc --noEmit`, never run: a
// refusal that stops holding fails the typecheck on its unused directive.
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import { type CloseReason, defineCollection, getCollection } from '@nxgt/mongo';
import { Meilisearch } from 'meilisearch';
import { MongoClient, type ObjectId } from 'mongodb';
import { z } from 'zod';
import {
	createSearchSync,
	type ReindexReport,
	type SearchSyncState,
} from '../../src';
import { articleIndex, articles } from '../fixtures';

const db = new MongoClient('mongodb://127.0.0.1:1').db('unused');
const meili = new Meilisearch({ host: 'http://127.0.0.1:1' });
const collection = getCollection(db, articles);
const index = bindIndex(meili, articleIndex);

const counters = defineCollection({
	name: 'counters',
	schema: z.object({ _id: z.int(), label: z.string() }),
});
const counterIndex = bindIndex(
	meili,
	defineIndex<{ n: number; label: string }>()({
		uid: 'counters',
		primaryKey: 'n',
		settings: {},
	}),
);
const counterCollection = getCollection(db, counters);

// The transform is typed by both sides.
createSearchSync({
	collection,
	index,
	transform: (article) => {
		const title: string = article.title;
		const id: ObjectId = article._id;
		const deletedAt: Date | null = article.deletedAt;
		return { id: String(id), title: `${title}${String(deletedAt)}` };
	},
});

createSearchSync({
	collection,
	index,
	// @ts-expect-error the document has no `body`
	transform: (article) => ({ id: String(article._id), title: article.body }),
});

createSearchSync({
	collection,
	index,
	// @ts-expect-error the index's document has no `body`
	transform: (article) => ({ id: String(article._id), body: article.title }),
});

createSearchSync({
	collection,
	index,
	// @ts-expect-error the index's `id` is a string
	transform: (article) => ({ id: article._id, title: article.title }),
});

createSearchSync({
	collection,
	index,
	// @ts-expect-error a transform gives a document or null, nothing else
	transform: (article) => article.title,
});

createSearchSync({
	collection,
	index,
	// @ts-expect-error nor a list of documents
	transform: (article) => [{ id: String(article._id), title: article.title }],
});

createSearchSync({
	collection,
	index,
	// Async, and `null` to keep a document out.
	transform: async (article) =>
		article.draft ? null : { id: String(article._id), title: article.title },
});

// `toIndexId` is optional for string ids, and required for any other.
createSearchSync({
	collection: counterCollection,
	index: counterIndex,
	toIndexId: (id) => id,
	transform: (counter) => ({ n: counter._id, label: counter.label }),
});

// @ts-expect-error numeric index ids need a toIndexId
createSearchSync({
	collection: counterCollection,
	index: counterIndex,
	transform: (counter) => ({ n: counter._id, label: counter.label }),
});

createSearchSync({
	collection: counterCollection,
	index: counterIndex,
	// @ts-expect-error toIndexId gives the index's id type
	toIndexId: (id) => String(id),
	transform: (counter) => ({ n: counter._id, label: counter.label }),
});

createSearchSync({
	collection,
	index,
	// @ts-expect-error toIndexId takes the collection's id type
	toIndexId: (id: number) => String(id),
	transform: () => null,
});

createSearchSync({
	// @ts-expect-error a collection from getCollection, not the driver's
	collection: db.collection('articles'),
	index,
	transform: () => null,
});

createSearchSync({
	collection,
	// @ts-expect-error an index from bindIndex, not the SDK's
	index: meili.index('articles'),
	transform: () => null,
});

createSearchSync({
	collection,
	index,
	transform: () => null,
	// @ts-expect-error 'reindex' or 'fail'
	onHistoryLost: 'ignore',
});

createSearchSync({
	collection,
	index,
	transform: () => null,
	batchSize: 100,
	flushIntervalMs: 250,
	positionIntervalMs: 30_000,
	pageSize: 50,
	// @ts-expect-error there is no such option
	flushInterval: 250,
});

// @ts-expect-error a transform is required
createSearchSync({ collection, index });

// What it gives back is typed.
export async function results() {
	const search = createSearchSync({ collection, index, transform: () => null });
	const report: ReindexReport = await search.reindex();
	const state: SearchSyncState | undefined = await search.state();
	const running = await search.start();
	const reason: CloseReason = await running.closed;
	await using _disposed = running;
	return { report, state, reason };
}

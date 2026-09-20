// What createSearchSync refuses. Checked by `tsc --noEmit`, never run: a
// refusal that stops holding fails the typecheck on its unused directive.
import { createRepository, type PgDatabase, type Row } from '@nxgt/drizzle/pg';
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { Meilisearch } from 'meilisearch';
import { createSearchSync, type ReindexReport } from '../../src';
import { articleIndex } from '../fixtures';
import { articles } from '../schema';

// Never run: this file is typechecked, not executed.
const db = null as unknown as PgDatabase;
const meili = new Meilisearch({ host: 'http://127.0.0.1:1' });
const repository = createRepository(db, articles);
const index = bindIndex(meili, articleIndex);

const counters = pgTable('counters', {
	id: integer('id').primaryKey(),
	label: text('label').notNull(),
});
const counterRepository = createRepository(db, counters);
const counterIndex = bindIndex(
	meili,
	defineIndex<{ n: number; label: string }>()({
		uid: 'counters',
		primaryKey: 'n',
		settings: {},
	}),
);

const toId = (article: { id: string }) => article.id;

// The transform is typed by both sides.
createSearchSync({
	repository,
	index,
	toIndexId: toId,
	transform: (article) => {
		const title: string = article.title;
		const draft: boolean = article.draft;
		const deletedAt: Date | null = article.deletedAt;
		return { id: article.id, title: `${title}${draft}${String(deletedAt)}` };
	},
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	// @ts-expect-error the row has no `body`
	transform: (article) => ({ id: article.id, title: article.body }),
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	// @ts-expect-error the index's document has no `body`
	transform: (article) => ({ id: article.id, body: article.title }),
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	// @ts-expect-error the index's document needs `title` too
	transform: (article) => ({ id: article.id }),
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	// @ts-expect-error a transform gives a document or null, nothing else
	transform: (article) => article.title,
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	// @ts-expect-error nor a list of documents
	transform: (article) => [{ id: article.id, title: article.title }],
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	// Async, and `null` to keep a row out.
	transform: async (article) =>
		article.draft ? null : { id: article.id, title: article.title },
});

// @ts-expect-error toIndexId is required: no column is known to be the id
createSearchSync({ repository, index, transform: () => null });

// @ts-expect-error a transform is required
createSearchSync({ repository, index, toIndexId: toId });

createSearchSync({
	repository,
	index,
	// @ts-expect-error toIndexId gives the index's id type, a string here
	toIndexId: (article) => article.createdAt,
	transform: () => null,
});

createSearchSync({
	repository: counterRepository,
	index: counterIndex,
	toIndexId: (counter) => counter.id,
	transform: (counter) => ({ n: counter.id, label: counter.label }),
});

createSearchSync({
	repository: counterRepository,
	index: counterIndex,
	// @ts-expect-error the index's id is a number
	toIndexId: (counter) => String(counter.id),
	transform: (counter) => ({ n: counter.id, label: counter.label }),
});

createSearchSync({
	// @ts-expect-error a repository from createRepository, not the table
	repository: articles,
	index,
	toIndexId: () => 'a',
	transform: () => null,
});

createSearchSync({
	repository,
	// @ts-expect-error an index from bindIndex, not the SDK's
	index: meili.index('articles'),
	toIndexId: toId,
	transform: () => null,
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	transform: () => null,
	batchSize: 100,
	pageSize: 50,
	name: 'blog',
	// @ts-expect-error there is no such option
	flushIntervalMs: 250,
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	transform: () => null,
	// @ts-expect-error a number of documents, not a string
	batchSize: '500',
});

createSearchSync({
	repository,
	index,
	toIndexId: toId,
	transform: () => null,
	// @ts-expect-error a name, not a number
	name: 123,
});

// A repository over another table does not fit this index's transform.
createSearchSync({
	repository: counterRepository,
	index,
	// @ts-expect-error a counter has no `title`
	toIndexId: (counter) => counter.title,
	transform: () => null,
});

// What the methods take and give back is typed.
export async function results() {
	const search = createSearchSync({
		repository,
		index,
		toIndexId: toId,
		transform: () => null,
	});
	const report: ReindexReport = await search.reindexAll({ pageSize: 10 });
	const row = null as unknown as Row<typeof articles>;
	await search.indexRow(row, { wait: true });
	await search.indexRows([row]);
	await search.removeRow(row);
	await search.remove('a');
	await search.removeMany(['a', 'b']);
	// @ts-expect-error the index's ids are strings
	await search.remove(1);
	// @ts-expect-error a list of rows, not one
	await search.indexRows(row);
	// @ts-expect-error there is no such option
	await search.indexRow(row, { waitFor: true });
	// @ts-expect-error wait is a boolean
	await search.indexRow(row, { wait: 'yes' });
	const counter = null as unknown as Row<typeof counters>;
	// @ts-expect-error a row of this sync's table, not of another one
	await search.indexRow(counter);
	const name: string = search.name;
	return { report, name };
}

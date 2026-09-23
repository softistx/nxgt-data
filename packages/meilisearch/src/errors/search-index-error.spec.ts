import { describe, expect, test } from 'bun:test';
import type { Task } from 'meilisearch';
import { assertSucceeded, SearchIndexError } from './search-index-error';

const task = (overrides: Partial<Task>): Task => ({
	uid: 7,
	batchUid: 3,
	indexUid: 'movies',
	status: 'succeeded',
	type: 'documentAdditionOrUpdate',
	canceledBy: null,
	error: null,
	duration: 'PT0.01S',
	enqueuedAt: '2026-09-15T00:00:00Z',
	startedAt: '2026-09-15T00:00:00Z',
	finishedAt: '2026-09-15T00:00:00Z',
	...overrides,
});

describe('assertSucceeded', () => {
	test('returns a succeeded task', () => {
		const done = task({});
		expect(assertSucceeded(done, 'movies', 'add')).toBe(done);
	});

	test('throws TASK_FAILED with the task and its error, and names the call', () => {
		const error = {
			message: 'Document identifier `"a b"` is invalid.',
			code: 'invalid_document_id',
			type: 'invalid_request',
			link: 'https://docs.meilisearch.com/errors#invalid_document_id',
		};
		const failed = task({ status: 'failed', error });
		const thrown = (() => {
			try {
				assertSucceeded(failed, 'movies', 'add');
			} catch (e) {
				return e;
			}
		})() as SearchIndexError;
		expect(thrown).toBeInstanceOf(SearchIndexError);
		expect(thrown.code).toBe('TASK_FAILED');
		expect(thrown.indexUid).toBe('movies');
		expect(thrown.task).toBe(failed);
		expect(thrown.cause).toBe(error);
		expect(thrown.message).toBe(
			'Task 7 (add) on index "movies" failed: invalid_document_id',
		);
		// The server's sentence quotes the id: it stays on the cause.
		expect(thrown.message).not.toContain('a b');
		expect((thrown.cause as { message: string }).message).toContain('"a b"');
	});

	test('throws for a canceled task, which has no error', () => {
		expect(() =>
			assertSucceeded(task({ status: 'canceled' }), 'movies', 'add'),
		).toThrow(/^Task 7 \(add\) on index "movies" canceled$/);
	});
});

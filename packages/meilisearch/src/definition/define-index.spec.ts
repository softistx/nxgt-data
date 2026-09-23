import { describe, expect, test } from 'bun:test';
import { defineIndex } from './define-index';

test('defineIndex returns the config, frozen', () => {
	const config = {
		uid: 'books',
		primaryKey: 'isbn',
		settings: { sortableAttributes: ['year'] },
	} as const;
	const books = defineIndex<{ isbn: string; year: number }>()(config);
	expect(books).toEqual(config);
	expect(books).not.toBe(config);
	expect(Object.isFrozen(books)).toBe(true);
});

// What Meilisearch v1.53.2 refuses with `invalid_index_uid` is refused here,
// at definition; `bind-index.spec.ts` checks the server agrees.
describe('defineIndex refuses a uid Meilisearch would refuse', () => {
	const notAUid =
		'defineIndex: the uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _';
	/** Defines an index under `uid`, typed `string` so the types let it by. */
	const define = (uid: string) =>
		defineIndex<{ slug: string }>()({ uid, primaryKey: 'slug' });
	/** The refusal for `uid`: a bare `TypeError` whose message names no uid. */
	const refused = (uid: string) => {
		let error: unknown;
		try {
			define(uid);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(TypeError);
		expect(Object.getPrototypeOf(error)).toBe(TypeError.prototype);
		const { message } = error as TypeError;
		if (uid.length > 0) expect(message.includes(uid)).toBe(false);
		return message;
	};

	test('400 characters, the server’s bound, and every character a uid may hold', () => {
		expect(define('a'.repeat(400)).uid).toHaveLength(400);
		expect(define('Movies_2026-v2').uid).toBe('Movies_2026-v2');
		expect(define('0').uid).toBe('0');
	});

	test('401 characters', () => {
		expect(refused('a'.repeat(401))).toBe(notAUid);
	});

	test('*, alone or in a uid: a token rule would read it as a pattern', () => {
		expect(refused('*')).toBe(notAUid);
		expect(refused('docs_acme*')).toBe(notAUid);
	});

	test('a space, a dot, a slash', () => {
		expect(refused('my movies')).toBe(notAUid);
		expect(refused('movies.v2')).toBe(notAUid);
		expect(refused('tenant/movies')).toBe(notAUid);
	});

	test('unicode lookalikes', () => {
		// A fullwidth asterisk, an asterisk operator, a Cyrillic o, a no-break
		// space, a fullwidth solidus.
		for (const uid of [
			'movies＊',
			'movies∗',
			'mоvies',
			'my movies',
			'tenant／movies',
		]) {
			expect(refused(uid)).toBe(notAUid);
		}
	});

	test('an empty string, a trailing newline, or a uid that is not a string', () => {
		expect(refused('')).toBe(notAUid);
		expect(refused('movies\n')).toBe(notAUid);
		expect(refused(42 as never)).toBe(notAUid);
	});
});

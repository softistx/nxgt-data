import { expect, test } from 'bun:test';
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

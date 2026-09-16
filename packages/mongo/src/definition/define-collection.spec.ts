import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineCollection, stampsOf } from './define-collection';
import { actors, id, optimisticLock, softDelete, timestamps } from './fields';

describe('defineCollection', () => {
	test('returns the config, frozen, with its defaults', () => {
		const books = defineCollection({
			name: 'books',
			schema: z.object({ _id: id(), title: z.string() }),
		});
		expect(books.name).toBe('books');
		expect(books.indexes).toEqual([]);
		expect(books.validation).toEqual({ level: 'strict', action: 'error' });
		expect(Object.isFrozen(books)).toBe(true);
		expect(Object.isFrozen(books.indexes)).toBe(true);
	});

	test('keeps the validation and the indexes it is given', () => {
		const books = defineCollection({
			name: 'books',
			schema: z.object({ _id: id(), isbn: z.string() }),
			indexes: [{ key: { isbn: 1 }, unique: true }],
			validation: { level: 'moderate', action: 'warn' },
		});
		expect(books.validation).toEqual({ level: 'moderate', action: 'warn' });
		expect(books.indexes).toEqual([{ key: { isbn: 1 }, unique: true }]);
	});

	test('refuses a schema without _id', () => {
		expect(() =>
			defineCollection({
				name: 'books',
				schema: z.object({ title: z.string() }),
			}),
		).toThrow('"books"\'s schema has no _id');
	});

	test('the documents are the schema, read and written', () => {
		const books = defineCollection({
			name: 'books',
			schema: z.object({ _id: id(), title: z.string(), ...timestamps() }),
		});
		// `_id` and the timestamps have defaults: a write leaves them out, a
		// read gives them back.
		const written = books.schema.parse({ title: 'Dune' });
		expect(written.title).toBe('Dune');
		expect(written.createdAt).toBeInstanceOf(Date);
	});
});

describe('stampsOf', () => {
	test('reports the fields the collection gives a meaning to', () => {
		const full = defineCollection({
			name: 'users',
			schema: z.object({
				_id: id(),
				...timestamps(),
				...softDelete(),
				...optimisticLock(),
				...actors(),
			}),
		});
		expect(stampsOf(full)).toEqual({
			createdAt: true,
			updatedAt: true,
			deletedAt: true,
			version: true,
			createdBy: true,
			updatedBy: true,
			deletedBy: true,
		});
	});

	test('a schema with none of them has none', () => {
		const bare = defineCollection({
			name: 'logs',
			schema: z.object({ _id: id(), message: z.string() }),
		});
		expect(Object.values(stampsOf(bare)).some(Boolean)).toBe(false);
	});
});

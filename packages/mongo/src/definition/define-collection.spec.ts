import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineCollection } from './define-collection';
import { id, timestampField } from './fields';

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
			schema: z.object({ _id: id(), title: z.string() }),
			timestamps: true,
		});
		// `_id` and the timestamps have defaults: a write leaves them out, a
		// read gives them back.
		const written = books.schema.parse({ title: 'Dune' });
		expect(written.title).toBe('Dune');
		expect(written.createdAt).toBeInstanceOf(Date);
	});
});

describe('the stamp options', () => {
	test('a collection with none of them has none', () => {
		const logs = defineCollection({
			name: 'logs',
			schema: z.object({ _id: id(), message: z.string() }),
		});
		expect(logs.stamps).toEqual({
			createdAt: false,
			updatedAt: false,
			deletedAt: false,
			version: false,
			createdBy: false,
			updatedBy: false,
			deletedBy: false,
		});
		expect(Object.keys(logs.schema.shape)).toEqual(['_id', 'message']);
	});

	test('`true` adds every field under its default name', () => {
		const users = defineCollection({
			name: 'users',
			schema: z.object({ _id: id(), email: z.email() }),
			timestamps: true,
			softDelete: true,
			optimisticLock: true,
			actors: true,
		});
		expect(users.stamps).toEqual({
			createdAt: 'createdAt',
			updatedAt: 'updatedAt',
			deletedAt: 'deletedAt',
			version: 'version',
			createdBy: 'createdBy',
			updatedBy: 'updatedBy',
			deletedBy: 'deletedBy',
		});
		// The fields reached the schema, so the validator will declare them.
		const written = users.schema.parse({ email: 'ada@example.com' });
		expect(written.createdAt).toBeInstanceOf(Date);
		expect(written.deletedAt).toBeNull();
		expect(written.version).toBe(0);
		expect(written.createdBy).toBeNull();
	});

	test('a name renames the field, everywhere', () => {
		const users = defineCollection({
			name: 'users',
			schema: z.object({ _id: id(), email: z.email() }),
			softDelete: { deletedAt: 'removedAt' },
			optimisticLock: { version: 'revision' },
		});
		expect(users.stamps.deletedAt).toBe('removedAt');
		expect(users.stamps.version).toBe('revision');

		const shape = Object.keys(users.schema.shape);
		expect(shape).toContain('removedAt');
		expect(shape).toContain('revision');
		// The default names are not there: the field moved, it was not added.
		expect(shape).not.toContain('deletedAt');
		expect(shape).not.toContain('version');
	});

	test('a timestamp is renamed, or turned off, on its own', () => {
		const users = defineCollection({
			name: 'users',
			schema: z.object({ _id: id() }),
			timestamps: { createdAt: 'createdDate' },
		});
		expect(users.stamps.createdAt).toBe('createdDate');
		// A key that is absent means on, under its default name: naming one
		// field says nothing about the other.
		expect(users.stamps.updatedAt).toBe('updatedAt');
		expect(Object.keys(users.schema.shape)).toContain('createdDate');

		const events = defineCollection({
			name: 'events',
			schema: z.object({ _id: id() }),
			timestamps: { updatedAt: false },
		});
		expect(events.stamps.createdAt).toBe('createdAt');
		expect(events.stamps.updatedAt).toBe(false);
		expect(Object.keys(events.schema.shape)).not.toContain('updatedAt');
	});

	test('the actor keeps the type it was given', () => {
		const users = defineCollection({
			name: 'users',
			schema: z.object({ _id: id() }),
			actors: { type: z.string() },
		});
		const written = users.schema.parse({ createdBy: 'ada' });
		expect(written.createdBy).toBe('ada');
		expect(() => users.schema.parse({ createdBy: 42 })).toThrow();
	});

	test('one actor field can be turned off on its own', () => {
		const users = defineCollection({
			name: 'users',
			schema: z.object({ _id: id() }),
			actors: { deletedBy: false },
		});
		expect(users.stamps.createdBy).toBe('createdBy');
		expect(users.stamps.deletedBy).toBe(false);
		expect(Object.keys(users.schema.shape)).not.toContain('deletedBy');
	});

	test('refuses a field the schema already declares', () => {
		expect(() =>
			defineCollection({
				name: 'users',
				// Declaring the field by hand *and* asking for the option adds it
				// twice, which is the one thing this refuses.
				schema: z.object({ _id: id(), createdAt: timestampField() }),
				timestamps: true,
			}),
		).toThrow('declares "createdAt" in its schema');
	});

	test('refuses an empty name', () => {
		expect(() =>
			defineCollection({
				name: 'users',
				schema: z.object({ _id: id() }),
				softDelete: { deletedAt: '' },
			}),
		).toThrow('is not a field name');
	});
});

describe('the MongoDB collection options', () => {
	test('a collection with none has an empty, frozen set', () => {
		const books = defineCollection({
			name: 'books',
			schema: z.object({ _id: id() }),
		});
		expect(books.options).toEqual({});
		expect(Object.isFrozen(books.options)).toBe(true);
	});

	test('keeps the options it is given', () => {
		const audit = defineCollection({
			name: 'audit',
			schema: z.object({ _id: id(), message: z.string() }),
			options: { capped: { size: 4096, max: 10 } },
		});
		expect(audit.options).toEqual({ capped: { size: 4096, max: 10 } });
	});

	test('a time series validates nothing, because MongoDB refuses to', () => {
		// "'timeseries' is not allowed with 'validator'" is what creating one
		// with a validator answers, so the default turns itself off here
		// rather than build a definition that can only fail at deploy time.
		const readings = defineCollection({
			name: 'readings',
			schema: z.object({ _id: id(), at: z.date() }),
			options: { timeseries: { timeField: 'at' } },
		});
		expect(readings.validation.level).toBe('off');
	});

	test('and asking for one anyway is refused where it is written', () => {
		expect(() =>
			defineCollection({
				name: 'readings',
				schema: z.object({ _id: id(), at: z.date() }),
				options: { timeseries: { timeField: 'at' } },
				validation: { level: 'strict' },
			}),
		).toThrow('MongoDB refuses to give one a validator');
	});
});

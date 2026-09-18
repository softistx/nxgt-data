import { describe, expect, test } from 'bun:test';
import { defineCollection, id } from '@nxgt/mongo';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { defineConfig } from './define-config';

const users = defineCollection({
	name: 'users',
	schema: z.object({ _id: id(), email: z.string() }),
});

const people = defineCollection({
	name: 'users',
	schema: z.object({ _id: id(), email: z.string() }),
});

const uri = 'mongodb://127.0.0.1:27017/app';

describe('defineConfig', () => {
	test('names the only database `default`', () => {
		const config = defineConfig({ uri, collections: { users } });
		expect(Object.keys(config.databases)).toEqual(['default']);
		expect(config.databases.default?.uri).toBe(uri);
	});

	test('keeps the names a multi-database config gave', () => {
		const config = defineConfig({
			databases: {
				main: { uri, collections: { users } },
				analytics: { uri, collections: { users } },
			},
		});
		expect(Object.keys(config.databases)).toEqual(['main', 'analytics']);
	});

	test('freezes what it gives back', () => {
		const config = defineConfig({ uri, collections: { users } });
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.databases)).toBe(true);
	});

	test('connects to nothing', () => {
		// A wrong host is still a valid configuration: `createKit` connects.
		expect(() =>
			defineConfig({
				uri: 'mongodb://nowhere.invalid:1/app',
				collections: { users },
			}),
		).not.toThrow();
	});

	test('takes a client the application opened', () => {
		const client = new MongoClient(uri);
		const config = defineConfig({ client, collections: { users } });
		expect(config.databases.default?.client).toBe(client);
	});

	describe('refuses', () => {
		test('no configuration at all', () => {
			expect(() => defineConfig(undefined as never)).toThrow(
				'a configuration object is required',
			);
		});

		test('an empty `databases`', () => {
			expect(() => defineConfig({ databases: {} } as never)).toThrow(
				'databases names none',
			);
		});

		test('a `databases` that is not an object', () => {
			expect(() => defineConfig({ databases: 'main' } as never)).toThrow(
				'databases is not an object',
			);
		});

		test('both a uri and a client', () => {
			const client = new MongoClient(uri);
			expect(() =>
				defineConfig({ uri, client, collections: { users } } as never),
			).toThrow('has both a uri and a client');
		});

		test('neither a uri nor a client', () => {
			expect(() => defineConfig({ collections: { users } } as never)).toThrow(
				'has neither a uri nor a client',
			);
		});

		test('a uri that is not a string', () => {
			expect(() =>
				defineConfig({ uri: 27017, collections: { users } } as never),
			).toThrow('has a uri that is not a string');
		});

		test('a client that is not one', () => {
			expect(() =>
				defineConfig({
					client: { db: 'app' },
					collections: { users },
				} as never),
			).toThrow('has a client that is not a MongoClient');
		});

		test('client options beside a client', () => {
			const client = new MongoClient(uri);
			expect(() =>
				defineConfig({
					client,
					clientOptions: { maxPoolSize: 1 },
					collections: { users },
				} as never),
			).toThrow('has client options beside a client');
		});

		test('an empty database name', () => {
			expect(() =>
				defineConfig({ uri, database: '', collections: { users } } as never),
			).toThrow('has an empty database name');
		});

		test('no collections object', () => {
			expect(() => defineConfig({ uri } as never)).toThrow(
				'has no collections object',
			);
		});

		test('a module with no definition in it', () => {
			expect(() =>
				defineConfig({ uri, collections: { helper: () => 1 } } as never),
			).toThrow('with no definition in it');
		});

		test('two keys on one server collection', () => {
			expect(() =>
				defineConfig({ uri, collections: { users, people } } as never),
			).toThrow('wires "users" and "people" to the same collection, "users"');
		});

		test('options for a key it does not wire', () => {
			expect(() =>
				defineConfig({
					uri,
					collections: { users },
					optionsFor: { posts: { maxPageSize: 10 } },
				} as never),
			).toThrow('has options for "posts", which it does not wire');
		});

		test('an option the kit decides, for every collection', () => {
			expect(() =>
				defineConfig({
					uri,
					collections: { users },
					options: { session: undefined },
				} as never),
			).toThrow('has "session" in options, which the kit decides');
		});

		test('an option the kit decides, under one key', () => {
			expect(() =>
				defineConfig({
					uri,
					collections: { users },
					optionsFor: { users: { autoSync: true } },
				} as never),
			).toThrow('has "autoSync" in the options of "users"');
		});

		test('and names the database it is talking about', () => {
			expect(() =>
				defineConfig({
					databases: { analytics: { collections: { users } } },
				} as never),
			).toThrow('database "analytics"');
		});
	});
});

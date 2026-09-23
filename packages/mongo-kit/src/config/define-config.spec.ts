import { describe, expect, test } from 'bun:test';
import { defineCollection, id } from '@nxgt/mongo';
import { defineBucket } from '@nxgt/mongo/gridfs';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { KitError } from '../errors/kit-error';
import { defineConfig } from './define-config';

const users = defineCollection({
	name: 'users',
	schema: z.object({ _id: id(), email: z.string() }),
});

const people = defineCollection({
	name: 'users',
	schema: z.object({ _id: id(), email: z.string() }),
});

const avatars = defineBucket({ name: 'avatars' });

/** Another key on the same server bucket. */
const pictures = defineBucket({ name: 'avatars' });

const uri = 'mongodb://127.0.0.1:27017/app';

describe('defineConfig', () => {
	/** The error a call threw, or a failure that says it did not throw. */
	const thrown = (fn: () => unknown): unknown => {
		try {
			fn();
		} catch (error) {
			return error;
		}
		throw new Error('it did not throw, and should have');
	};

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

	test('keeps the buckets and their options it was given', () => {
		const config = defineConfig({
			uri,
			collections: { users },
			buckets: { avatars, helper: 1 },
			bucketOptions: { hash: false },
		});
		expect(config.databases.default?.buckets?.avatars).toBe(avatars);
		expect(config.databases.default?.bucketOptions).toEqual({ hash: false });
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

		test('a `databases` that is not an object, and says what one looks like', () => {
			expect(() => defineConfig({ databases: 'main' } as never)).toThrow(
				'databases must be an object of databases by name',
			);
		});

		test('every refusal is a KitError with the CONFIG code', () => {
			for (const bad of [
				undefined,
				{ databases: 'main' },
				{ databases: {} },
				{ uri, collections: {} },
			]) {
				const error = thrown(() => defineConfig(bad as never));
				expect(error).toBeInstanceOf(KitError);
				expect(error).toHaveProperty('code', 'CONFIG');
				// It still answers to `TypeError`, which is what this package threw
				// before `KitError` existed: no consumer's `catch` stopped working.
				expect(error).toBeInstanceOf(TypeError);
			}
		});

		test('names the database it is about', () => {
			// Not a bare `try`/`catch`: with nothing on the resolved path, a
			// `defineConfig` that stopped refusing would pass this with zero
			// assertions run.
			const error = thrown(() =>
				defineConfig({
					databases: { analytics: { uri, collections: {} } },
				} as never),
			);
			expect(error).toHaveProperty('database', 'analytics');
			expect(error).toHaveProperty('code', 'CONFIG');
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

		describe('of the buckets', () => {
			test('a key that is also a collection', () => {
				const error = thrown(() =>
					defineConfig({
						uri,
						collections: { users },
						buckets: { users: avatars },
					} as never),
				);
				expect(error).toBeInstanceOf(KitError);
				expect(error).toHaveProperty('code', 'CONFIG');
				expect(error).toHaveProperty('key', 'users');
				expect(error).toHaveProperty(
					'message',
					'defineConfig: database "default" wires "users" as both a ' +
						'collection and a bucket: export one of them under another name',
				);
			});

			test('two keys on one bucket', () => {
				expect(() =>
					defineConfig({
						uri,
						collections: { users },
						buckets: { avatars, pictures },
					}),
				).toThrow(
					'wires "avatars" and "pictures" to the same bucket, "avatars"',
				);
			});

			test('a module with no bucket in it', () => {
				// A collection is no bucket: the shapes tell them apart.
				for (const bad of [{ users }, {}, 'avatars']) {
					expect(() =>
						defineConfig({
							uri,
							collections: { users },
							buckets: bad,
						} as never),
					).toThrow('has a buckets object with no bucket definition in it');
				}
			});

			test('the session, which the kit decides', () => {
				expect(() =>
					defineConfig({
						uri,
						collections: { users },
						buckets: { avatars },
						bucketOptions: { hash: false, session: undefined },
					} as never),
				).toThrow('has "session" in bucketOptions, which the kit decides');
			});

			test('autoSync, which is the database`s', () => {
				const error = thrown(() =>
					defineConfig({
						uri,
						collections: { users },
						buckets: { avatars },
						bucketOptions: { autoSync: true },
					} as never),
				);
				expect(error).toHaveProperty('code', 'CONFIG');
				expect(error).toHaveProperty(
					'message',
					expect.stringContaining(
						'has "autoSync" in bucketOptions, which the kit decides',
					),
				);
			});
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

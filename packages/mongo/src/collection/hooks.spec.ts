import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { ObjectId } from 'mongodb';
import { posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { withTransaction } from '../transaction/with-transaction';
import { getCollection } from './get-collection';
import type { CollectionHooks, WriteOperation } from './hook-types';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo('nxgt-hooks');
}, 120_000);
beforeEach(async () => {
	await t.reset();
	await getCollection(t.db, users).sync();
	await getCollection(t.db, posts).sync();
});
afterAll(() => t.stop());

const stored = (name: string) => t.db.collection(name).find().toArray();

describe('create', () => {
	test('a before hook fills what the write takes', async () => {
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeCreate: ({ values }) => ({
					values: { ...values, email: values.email.toLowerCase() },
				}),
			},
		});
		const ada = await collection.create({ email: 'ADA@example.com' });
		expect(ada.email).toBe('ada@example.com');
		expect((await stored('users'))[0]?.email).toBe('ada@example.com');
	});

	test('returning nothing keeps it as it was', async () => {
		const seen: string[] = [];
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeCreate: ({ values }) => {
					seen.push(values.email);
				},
			},
		});
		const ada = await collection.create({ email: 'ada@example.com' });
		expect(ada.email).toBe('ada@example.com');
		expect(seen).toEqual(['ada@example.com']);
	});

	test('a before hook that throws stops the write', async () => {
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeCreate: () => {
					throw new Error('not today');
				},
			},
		});
		await expect(
			collection.create({ email: 'ada@example.com' }),
		).rejects.toThrow('not today');
		expect(await stored('users')).toEqual([]);
	});

	test('an after hook sees the document as it was stored, id and all', async () => {
		const created: unknown[] = [];
		const collection = getCollection(t.db, users, {
			hooks: {
				afterCreate: (document, { values, operation }) => {
					created.push([
						document.id,
						document.version,
						values.email,
						operation,
					]);
				},
			},
		});
		const ada = await collection.create({ email: 'ada@example.com' });
		expect(created).toEqual([[ada.id, 0, 'ada@example.com', 'create']]);
	});

	test('an after hook that throws rejects, but the write happened', async () => {
		const collection = getCollection(t.db, users, {
			hooks: {
				afterCreate: () => {
					throw new Error('too late');
				},
			},
		});
		await expect(
			collection.create({ email: 'ada@example.com' }),
		).rejects.toThrow('too late');
		expect(await stored('users')).toHaveLength(1);
	});

	test('createMany runs them once per document, around one insert', async () => {
		const order: string[] = [];
		const collection = getCollection(t.db, posts, {
			hooks: {
				beforeCreate: ({ values }) => {
					order.push(`before ${values.title}`);
					return { values: { ...values, rank: values.rank * 10 } };
				},
				afterCreate: (document, { operation }) => {
					order.push(`after ${document.title} ${operation}`);
				},
			},
		});
		const created = await collection.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect(created.map((post) => post.rank)).toEqual([10, 20]);
		expect(order).toEqual([
			'before a',
			'before b',
			'after a createMany',
			'after b createMany',
		]);
	});
});

describe('several hook sets', () => {
	test('run in order, each seeing what the last one returned', async () => {
		const collection = getCollection(t.db, posts, {
			hooks: [
				{
					beforeCreate: ({ values }) => ({
						values: { ...values, title: `${values.title}!` },
					}),
				},
				{
					beforeCreate: ({ values }) => ({
						values: { ...values, title: values.title.toUpperCase() },
					}),
				},
			],
		});
		const post = await collection.create({ title: 'hi', rank: 1 });
		expect(post.title).toBe('HI!');
	});
});

describe('update', () => {
	test('a before hook changes the patch, the after hook sees the result', async () => {
		const seen: unknown[] = [];
		const base = getCollection(t.db, posts);
		const post = await base.create({ title: 'a', rank: 1 });
		const collection = getCollection(t.db, posts, {
			hooks: {
				beforeUpdate: ({ id, patch }) => ({
					id,
					patch: { ...patch, tags: ['edited'] },
				}),
				afterUpdate: (document, { id }) => {
					seen.push([document.title, document.tags, id.equals(post._id)]);
				},
			},
		});
		await collection.update(post._id, { title: 'b' });
		expect(seen).toEqual([['b', ['edited'], true]]);
	});

	test('updateMany: a before hook narrows the filter', async () => {
		const base = getCollection(t.db, posts);
		await base.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		const counts: number[] = [];
		// The shape a tenant rule takes: whatever the caller asked, never
		// outside the rows it may touch.
		const collection = getCollection(t.db, posts, {
			hooks: {
				beforeUpdateMany: ({ filter, patch }) => ({
					filter: { $and: [filter, { rank: { $lt: 2 } }] },
					patch,
				}),
				afterUpdateMany: (count) => {
					counts.push(count);
				},
			},
		});
		const changed = await collection.updateMany(
			{ _id: { $exists: true } },
			{ title: 'z' },
		);
		expect(changed).toBe(1);
		expect(counts).toEqual([1]);
		expect((await stored('posts')).map((p) => p.title).sort()).toEqual([
			'b',
			'z',
		]);
	});
});

describe('a hook that narrows a filter', () => {
	test('does not let an empty filter through', async () => {
		// The shape a tenant rule takes: `{ $and: [filter, …] }` is never
		// empty, so a guard that ran after the hook would let `{}` through.
		let ran = 0;
		const collection = getCollection(t.db, posts, {
			hooks: {
				beforeDeleteMany: ({ filter }) => {
					ran += 1;
					return { filter: { $and: [filter, { rank: { $gte: 0 } }] } };
				},
				beforeUpdateMany: ({ filter, patch }) => {
					ran += 1;
					return { filter: { $and: [filter, { rank: { $gte: 0 } }] }, patch };
				},
			},
		});
		await collection.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		await expect(collection.deleteMany({})).rejects.toThrow('needs a filter');
		await expect(collection.hardDeleteMany({})).rejects.toThrow(
			'needs a filter',
		);
		await expect(collection.updateMany({}, { title: 'z' })).rejects.toThrow(
			'needs a filter',
		);
		// Refused before any hook ran, side effects included.
		expect(ran).toBe(0);
		expect(await stored('posts')).toHaveLength(2);
	});
});

describe('delete', () => {
	function recording() {
		const calls: [string, WriteOperation, boolean][] = [];
		const hooks: CollectionHooks<typeof users> = {
			beforeDelete: (_args, { operation, hard }) => {
				calls.push(['before', operation, hard]);
			},
			afterDelete: (_document, { operation, hard }) => {
				calls.push(['after', operation, hard]);
			},
			beforeDeleteMany: (_args, { operation, hard }) => {
				calls.push(['beforeMany', operation, hard]);
			},
			afterDeleteMany: (count, { operation, hard }) => {
				calls.push([`afterMany ${count}`, operation, hard]);
			},
		};
		return { calls, hooks };
	}

	test('says whether the document goes for good', async () => {
		const { calls, hooks } = recording();
		const collection = getCollection(t.db, users, { hooks });
		const ada = await collection.create({ email: 'ada@example.com' });
		const bob = await collection.create({ email: 'bob@example.com' });
		await collection.delete(ada._id);
		await collection.hardDelete(bob._id);
		expect(calls).toEqual([
			['before', 'delete', false],
			['after', 'delete', false],
			['before', 'hardDelete', true],
			['after', 'hardDelete', true],
		]);
	});

	test('a delete that cannot be soft is a hard one, and says so', async () => {
		const { calls, hooks } = recording();
		const collection = getCollection(t.db, users, {
			hooks,
			softDelete: false,
		});
		const ada = await collection.create({ email: 'ada@example.com' });
		await collection.delete(ada._id);
		expect(calls[0]).toEqual(['before', 'delete', true]);
		expect(await stored('users')).toEqual([]);
	});

	test('the many forms count what they deleted', async () => {
		const { calls, hooks } = recording();
		const collection = getCollection(t.db, users, { hooks });
		await collection.createMany([
			{ email: 'ada@example.com' },
			{ email: 'bob@example.com' },
		]);
		await collection.deleteMany({ email: 'ada@example.com' });
		await collection.hardDeleteMany({ _id: { $exists: true } });
		expect(calls).toEqual([
			['beforeMany', 'deleteMany', false],
			['afterMany 1', 'deleteMany', false],
			['beforeMany', 'hardDeleteMany', true],
			['afterMany 2', 'hardDeleteMany', true],
		]);
	});

	test('restore has hooks of its own', async () => {
		const seen: unknown[] = [];
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeRestore: ({ id }) => {
					seen.push(['before', id instanceof ObjectId]);
				},
				afterRestore: (document) => {
					seen.push(['after', document.deletedAt]);
				},
			},
		});
		const ada = await collection.create({ email: 'ada@example.com' });
		await collection.delete(ada._id);
		await collection.restore(ada._id);
		expect(seen).toEqual([
			['before', true],
			['after', null],
		]);
	});
});

describe('the context', () => {
	test('carries the actor, and as() keeps the hooks', async () => {
		const actors: unknown[] = [];
		const alice = new ObjectId();
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeCreate: (_args, { actor }) => {
					actors.push(actor);
				},
			},
		});
		await collection.create({ email: 'a@example.com' });
		await collection.as(alice).create({ email: 'b@example.com' });
		expect(actors).toEqual([undefined, alice]);
	});

	test('is the collection the write runs on, session included', async () => {
		// An audit trail written in the same transaction as the document: when
		// the transaction is abandoned, neither is kept.
		const collection = getCollection(t.db, posts, {
			hooks: {
				afterCreate: async (document, { collection: self, session }) => {
					await self.db
						.collection('audit')
						.insertOne({ post: document._id }, { session });
				},
			},
		});
		await t.db.createCollection('audit');

		await withTransaction(t.client, async (session) => {
			await collection.withSession(session).create({ title: 'kept', rank: 1 });
		});
		await expect(
			withTransaction(t.client, async (session) => {
				await collection
					.withSession(session)
					.create({ title: 'dropped', rank: 2 });
				throw new Error('abandon');
			}),
		).rejects.toThrow('abandon');

		expect((await stored('posts')).map((p) => p.title)).toEqual(['kept']);
		expect(await stored('audit')).toHaveLength(1);
	});

	test('reads run no hooks', async () => {
		let calls = 0;
		const count = () => {
			calls += 1;
		};
		const collection = getCollection(t.db, posts, {
			hooks: { beforeCreate: count, afterCreate: count },
		});
		const post = await collection.create({ title: 'a', rank: 1 });
		calls = 0;
		await collection.findById(post._id);
		await collection.findMany();
		await collection.count();
		expect(calls).toBe(0);
	});
});

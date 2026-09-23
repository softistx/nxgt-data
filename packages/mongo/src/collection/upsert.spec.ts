import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import type { Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { rejection, rejectionMessage } from '../../test/rejection';
import { posts, tickets, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { defineCollection } from '../definition/define-collection';
import { id, objectId } from '../definition/fields';
import { ConflictError, DataError } from '../errors/data-error';
import { withTransaction } from '../transaction/with-transaction';
import { getCollection } from './get-collection';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

async function synced() {
	const collection = getCollection(t.db, users);
	await collection.sync();
	return collection;
}

/**
 * A required field with no default, and **no validator on the server**: what
 * an upsert refuses here is the package's own check and nothing else.
 * Measured with that check taken out, an upsert missing `plan` throws nothing
 * and stores `{ email }` — a document the schema would never have accepted.
 */
const strictOff = defineCollection({
	name: 'strict-upsert',
	validation: { level: 'off' },
	schema: z.object({ _id: id(), email: z.string(), plan: z.string() }),
});

describe('an upsert that inserts', () => {
	test('lands the document `create` would have landed', async () => {
		const collection = await synced();
		const created = await collection.create({ email: 'ada@example.com' });
		const upserted = await collection.upsert(
			{ email: 'grace@example.com' },
			{ name: 'Grace' },
		);

		// The filter's field is on the new document: the server seeds an
		// insert from the equality conditions of the filter it did not match.
		expect(upserted.email).toBe('grace@example.com');
		expect(upserted.name).toBe('Grace');
		// And everything else reads exactly as a create's does.
		expect(upserted.version).toBe(created.version);
		expect(upserted.deletedAt).toBe(null);
		expect(upserted.teamId).toBe(null);
		expect(upserted.createdAt).toBeInstanceOf(Date);
		expect(upserted.updatedAt).toBeInstanceOf(Date);
		expect(await collection.count()).toBe(2);
	});

	test('starts the version at 0, as a create does', async () => {
		const collection = await synced();
		const upserted = await collection.upsert(
			{ email: 'ada@example.com' },
			{ name: 'Ada' },
		);
		// `$inc` alone would give 1 here — measured — and `$setOnInsert` beside
		// it is refused by the server. The pipeline is what makes this a 0.
		expect(upserted.version).toBe(0);
	});

	test('stamps the actor as the one who created it', async () => {
		const actor = new ObjectId();
		const collection = (await synced()).as(actor);
		const upserted = await collection.upsert(
			{ email: 'ada@example.com' },
			{ name: 'Ada' },
		);
		expect(upserted.createdBy).toEqual(actor);
		expect(upserted.updatedBy).toEqual(actor);
	});
});

describe('an upsert that matches', () => {
	test('changes the document and leaves what it did not name', async () => {
		const collection = await synced();
		const created = await collection.create({
			email: 'ada@example.com',
			name: 'Ada',
		});
		const upserted = await collection.upsert(
			{ email: 'ada@example.com' },
			{ age: 36 },
		);

		expect(upserted._id).toEqual(created._id);
		expect(upserted.name).toBe('Ada');
		expect(upserted.age).toBe(36);
		expect(await collection.count()).toBe(1);
	});

	test('raises the version and keeps `createdAt` where it was', async () => {
		const collection = await synced();
		const created = await collection.create({ email: 'ada@example.com' });
		const upserted = await collection.upsert(
			{ email: 'ada@example.com' },
			{ name: 'Ada' },
		);
		expect(upserted.version).toBe(created.version + 1);
		expect(upserted.createdAt).toEqual(created.createdAt);
	});

	test('leaves the actor who created it alone', async () => {
		const first = new ObjectId();
		const second = new ObjectId();
		const collection = await synced();
		await collection.as(first).upsert({ email: 'ada@example.com' }, {});
		const again = await collection
			.as(second)
			.upsert({ email: 'ada@example.com' }, { name: 'Ada' });
		expect(again.createdBy).toEqual(first);
		expect(again.updatedBy).toEqual(second);
	});

	test('does not see a soft-deleted document, as no other write does', async () => {
		const collection = await synced();
		const created = await collection.create({ email: 'ada@example.com' });
		await collection.delete(created._id);
		// Scoped to the live documents like every write, so this inserts —
		// and the unique index on `email` is what refuses a second live one.
		expect(
			await rejection(
				collection.upsert({ email: 'ada@example.com' }, { name: 'Ada' }),
			),
		).toBeInstanceOf(ConflictError);
	});
});

describe('what an upsert refuses', () => {
	test('a filter that names no field by value', async () => {
		const collection = await synced();
		expect(
			await rejectionMessage(
				collection.upsert({ age: { $gt: 5 } } as never, { name: 'x' }),
			),
		).toMatch(/matched rather than given a value/);
		expect(
			await rejectionMessage(collection.upsert({} as never, { name: 'x' })),
		).toMatch(/at least one field by value/);
	});

	test('a filter matching a shape, which seeds nothing either', async () => {
		const collection = await synced();
		// Measured: an upsert filtered by a regular expression inserts a
		// document without the field at all — the server seeds only the
		// conditions that are equalities.
		expect(
			await rejectionMessage(
				collection.upsert({ email: /ada/ } as never, { name: 'Ada' }),
			),
		).toMatch(/matched rather than given a value/);
		expect(await collection.count()).toBe(0);
	});

	test('a filter that offers a choice', async () => {
		const collection = await synced();
		// Measured: the server seeds from the equalities inside `$and` and
		// `$or` too, so neither can be allowed to stand — a filter saying
		// "one team or the other" cannot say which one it would insert.
		expect(
			await rejectionMessage(
				collection.upsert(
					{ email: 'a@b.c', $or: [{ name: 'Ada' }] } as never,
					{},
				),
			),
		).toMatch(/cannot upsert through "\$or"/);
		expect(
			await rejectionMessage(
				collection.upsert({ $and: [{ email: 'a@b.c' }] } as never, {}),
			),
		).toMatch(/cannot upsert through "\$and"/);
	});

	test('a filter naming a path inside a field, or no field of the schema', async () => {
		const collection = await synced();
		expect(
			await rejectionMessage(
				collection.upsert({ 'name.first': 'Ada' } as never, {}),
			),
		).toMatch(/cannot upsert through the path "name.first"/);
		// A filter refuses an unknown field nowhere else in this package — in
		// an upsert it has to, because the server would **store** it.
		expect(
			await rejectionMessage(collection.upsert({ nope: 1 } as never, {})),
		).toMatch(/has no field "nope"/);
	});

	test('a filter on a stamp the collection keeps', async () => {
		const collection = await synced();
		expect(
			await rejectionMessage(
				collection.upsert({ version: 0 } as never, { name: 'Ada' }),
			),
		).toMatch(/keeps that field itself/);
	});

	test('a required field left out, on the half that matched too', async () => {
		const collection = getCollection(t.db, strictOff);
		await collection.sync();
		await collection.upsert({ email: 'ada@example.com' }, { plan: 'pro' });
		// The check cannot know which half will run, so a field an insert
		// would need is needed every time. This is the cost of the guarantee
		// that an upsert can always insert, and the README says so.
		expect(
			await rejectionMessage(
				collection.upsert({ email: 'ada@example.com' }, {}),
			),
		).toMatch(/plan/);
	});

	test('a field the schema does not have', async () => {
		const collection = await synced();
		expect(
			await rejectionMessage(
				collection.upsert({ email: 'a@b.c' }, { nope: 1 } as never),
			),
		).toMatch(/has no field "nope"/);
	});

	test('a document it could not insert, before it asks the server', async () => {
		const collection = getCollection(t.db, strictOff);
		await collection.sync();
		// `create` would name the field; so does this, and for the same
		// reason — an upsert that cannot insert is not an upsert.
		const error = await rejection(
			collection.upsert({ email: 'ada@example.com' }, {}),
		);
		expect(error).toBeInstanceOf(z.ZodError);
		expect((error as z.ZodError).message).toMatch(/plan/);
		expect(await collection.findMany({ filter: {} })).toEqual([]);
		// The same call with the field is fine, and the filter seeds `email`.
		const written = await collection.upsert(
			{ email: 'ada@example.com' },
			{ plan: 'pro' },
		);
		expect(written).toMatchObject({ email: 'ada@example.com', plan: 'pro' });
	});

	test('a stamp the collection keeps, at run time as in the types', async () => {
		const collection = await synced();
		// Named, and named as the collection's own: measured, a stamp that
		// reaches the schema instead is a `ZodError` that says only that the
		// field is unrecognised, which tells a caller nothing about `raw`.
		expect(
			await rejectionMessage(
				collection.upsert({ email: 'a@b.c' }, { version: 3 } as never),
			),
		).toMatch(/"version" is kept by "users" itself/);
		expect(
			await rejectionMessage(
				collection.upsert({ email: 'a@b.c' }, {
					createdBy: new ObjectId(),
				} as never),
			),
		).toMatch(/"createdBy" is kept by "users" itself/);
	});

	test('a value the schema refuses', async () => {
		const collection = await synced();
		expect(
			await rejection(collection.upsert({ email: 'a@b.c' }, { age: -1 })),
		).toBeInstanceOf(Error);
	});
});

describe('the values an upsert writes', () => {
	test('a string that starts with $ is written, not read as a path', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		// The measured trap of a pipeline update: unwrapped, `$100 off` is a
		// field path into a document that has none, and the field is dropped
		// in silence. It has to be in the **values** to measure that — a
		// field in the filter is seeded by the server, never by the stage.
		const inserted = await collection.upsert(
			{ rank: 7 },
			{ title: '$100 off' },
		);
		expect(inserted.title).toBe('$100 off');
		// And on the update half too, where nothing seeds anything.
		const updated = await collection.upsert({ rank: 7 }, { title: '$5 off' });
		expect(updated._id).toEqual(inserted._id);
		expect(updated.title).toBe('$5 off');
	});

	test('reads a string id and a date string, as every write does', async () => {
		const collection = await synced();
		const team = new ObjectId();
		const upserted = await collection.upsert(
			{ email: 'ada@example.com' },
			{ teamId: team.toHexString() },
		);
		expect(upserted.teamId).toEqual(team);
		expect(await collection.count({ teamId: team })).toBe(1);
	});
});

describe('the hooks an upsert runs', () => {
	const seen: string[] = [];
	beforeEach(() => {
		seen.length = 0;
	});

	function watched() {
		return getCollection(t.db, users, {
			hooks: {
				beforeUpsert: ({ filter, values }) => {
					seen.push('beforeUpsert');
					return { filter, values: { ...values, name: 'from the hook' } };
				},
				beforeCreate: () => {
					seen.push('beforeCreate');
				},
				beforeUpdate: () => {
					seen.push('beforeUpdate');
				},
				afterCreate: (document) => {
					seen.push(`afterCreate:${document.email}`);
				},
				afterUpdate: (document) => {
					seen.push(`afterUpdate:${document.email}`);
				},
			},
		});
	}

	test('runs beforeUpsert, then afterCreate when it inserted', async () => {
		const collection = watched();
		await collection.sync();
		const upserted = await collection.upsert({ email: 'ada@example.com' }, {});
		// The hook's return is what was written: a `before` hook narrows an
		// upsert exactly as it narrows any other write.
		expect(upserted.name).toBe('from the hook');
		expect(seen).toEqual(['beforeUpsert', 'afterCreate:ada@example.com']);
	});

	test('runs afterUpdate when it matched', async () => {
		const collection = watched();
		await collection.sync();
		await collection.upsert({ email: 'ada@example.com' }, {});
		seen.length = 0;
		await collection.upsert({ email: 'ada@example.com' }, { age: 1 });
		expect(seen).toEqual(['beforeUpsert', 'afterUpdate:ada@example.com']);
	});

	test('tells the after hook it was an upsert', async () => {
		const operations: string[] = [];
		const collection = getCollection(t.db, users, {
			hooks: {
				afterCreate: (_document, context) => {
					operations.push(context.operation);
				},
			},
		});
		await collection.sync();
		await collection.create({ email: 'grace@example.com' });
		await collection.upsert({ email: 'ada@example.com' }, {});
		expect(operations).toEqual(['create', 'upsert']);
	});
});

describe('a collection that keeps none of the stamps', () => {
	const plain = defineCollection({
		name: 'plain',
		schema: z.object({
			_id: id(),
			slug: z.string(),
			teamId: objectId().nullable().default(null),
		}),
	});

	test('upserts with nothing to stamp', async () => {
		const collection = getCollection(t.db, plain);
		await collection.sync();
		const first = await collection.upsert({ slug: 'a' }, {});
		expect(first.slug).toBe('a');
		expect(first.teamId).toBe(null);
		const again = await collection.upsert({ slug: 'a' }, {});
		expect(again._id).toEqual(first._id);
		expect(await collection.count()).toBe(1);
	});
});

describe('an upsert on the document it matched', () => {
	test('leaves a field stored as `null` where its default is not', async () => {
		const shaped = defineCollection({
			name: 'shaped',
			schema: z.object({
				_id: id(),
				slug: z.string(),
				status: z.string().nullable().default('new'),
			}),
		});
		const collection = getCollection(t.db, shaped);
		await collection.sync();
		const created = await collection.create({ slug: 'a', status: null });
		expect(created.status).toBe(null);
		const again = await collection.upsert({ slug: 'a' }, {});
		// A stored `null` is a value, not an absence: `$ifNull` cannot tell
		// them apart, which is why every branch asks `$type` instead.
		expect(again.status).toBe(null);
	});

	test('keeps an `updatedAt` the caller wrote, as `update` does', async () => {
		const collection = await synced();
		await collection.create({ email: 'ada@example.com' });
		const chosen = new Date('2020-01-01T00:00:00.000Z');
		const upserted = await collection.upsert(
			{ email: 'ada@example.com' },
			{ updatedAt: chosen },
		);
		expect(upserted.updatedAt).toEqual(chosen);
	});

	test('starts a version at 0 on a document that has none', async () => {
		// A document written before the collection gained its version, which
		// only a collection without a validator can hold. The naive
		// `$add` over a missing field is `null`, and every lock on that
		// document afterwards fails on a non-numeric version.
		const locked = defineCollection({
			name: 'locked-off',
			validation: { level: 'off' },
			schema: z.object({ _id: id(), slug: z.string() }),
			optimisticLock: true,
		});
		const collection = getCollection(t.db, locked);
		await collection.sync();
		await t.db.collection('locked-off').insertOne({ slug: 'a' });
		const upserted = await collection.upsert({ slug: 'a' }, {});
		expect(upserted.version).toBe(0);
		expect(await collection.count()).toBe(1);
	});

	test('raises a version already stored as `null`', async () => {
		// The state the naive `$add` leaves behind, so that an upsert can dig
		// a document out of it rather than write `null` over `null` for ever.
		const locked = defineCollection({
			name: 'null-version',
			validation: { level: 'off' },
			schema: z.object({ _id: id(), slug: z.string() }),
			optimisticLock: true,
		});
		const collection = getCollection(t.db, locked);
		await collection.sync();
		await t.db
			.collection('null-version')
			.insertOne({ slug: 'a', version: null });
		const upserted = await collection.upsert({ slug: 'a' }, {});
		expect(upserted.version).toBe(1);
	});
});

describe('an upsert filtered by `_id`', () => {
	test('inserts with that id, then updates it', async () => {
		const collection = await synced();
		const chosen = new ObjectId();
		const inserted = await collection.upsert(
			{ _id: chosen },
			{ email: 'ada@example.com' },
		);
		// The filter seeds `_id` itself, so no branch here may ask whether
		// `_id` is missing to know it is inserting.
		expect(inserted._id).toEqual(chosen);
		expect(inserted.version).toBe(0);
		const updated = await collection.upsert(
			{ _id: chosen },
			{ email: 'ada@example.com', name: 'Ada' },
		);
		expect(updated._id).toEqual(chosen);
		expect(updated.version).toBe(1);
		expect(updated.createdAt).toEqual(inserted.createdAt);
		expect(await collection.count()).toBe(1);
	});
});

describe('the configurations an upsert honours', () => {
	test('stamps under the names the collection chose', async () => {
		const collection = getCollection(t.db, tickets);
		await collection.sync();
		const actor = new ObjectId();
		const inserted = await collection.as(actor).upsert({ subject: 'a' }, {});
		expect(inserted.revision).toBe(0);
		expect(inserted.openedBy).toEqual(actor);
		expect(inserted.removedAt).toBe(null);
		const again = await collection.upsert({ subject: 'a' }, {});
		expect(again.revision).toBe(1);
		expect(again.openedBy).toEqual(actor);
	});

	test('without a lock, without a touch, the stamps stand still', async () => {
		const collection = getCollection(t.db, users, {
			optimisticLock: false,
			touchUpdatedAt: false,
		});
		await collection.sync();
		const inserted = await collection.upsert({ email: 'ada@example.com' }, {});
		const again = await collection.upsert(
			{ email: 'ada@example.com' },
			{ name: 'Ada' },
		);
		expect(again.version).toBe(inserted.version);
		expect(again.updatedAt).toEqual(inserted.updatedAt);
		expect(again.name).toBe('Ada');
	});

	test('without parsing, an insert lands what `create` lands', async () => {
		const defaulted = defineCollection({
			name: 'defaulted',
			validation: { level: 'off' },
			schema: z.object({
				_id: id(),
				slug: z.string(),
				tags: z.array(z.string()).default([]),
			}),
			timestamps: true,
		});
		const collection = getCollection(t.db, defaulted, { validate: 'off' });
		await collection.sync();
		const created = await collection.create({ slug: 'a' });
		const upserted = await collection.upsert({ slug: 'b' }, {});
		// `create` fills the stamps alone when it does not parse, so an
		// upsert fills the stamps alone too: the same document, either way.
		expect(Object.keys(upserted).sort()).toEqual(Object.keys(created).sort());
		expect(upserted.tags).toBeUndefined();
		expect(upserted.createdAt).toBeInstanceOf(Date);
	});

	test('without coercion, a string stays the string it was given', async () => {
		const collection = getCollection(t.db, users, { coerce: false });
		await collection.sync();
		const team = new ObjectId();
		expect(
			await rejection(
				collection.upsert({ email: 'a@b.c' }, {
					teamId: team.toHexString(),
				} as never),
			),
		).toBeInstanceOf(Error);
	});

	test('rolls back with the transaction it ran in', async () => {
		const collection = await synced();
		expect(
			await rejectionMessage(
				withTransaction(t.client, async (session) => {
					await collection
						.withSession(session)
						.upsert({ email: 'ada@example.com' }, { name: 'Ada' });
					throw new Error('rolled back');
				}),
			),
		).toContain('rolled back');
		expect(await collection.count()).toBe(0);
	});
});

describe('the edges an upsert answers for', () => {
	test('refuses a schema-filled `_id` it could not write', async () => {
		// The server generates `_id` before the pipeline runs, so a schema
		// that fills `_id` with something else would land a document `create`
		// would never have landed. Asked for, rather than silently wrong.
		const slugged = defineCollection({
			name: 'slugged',
			schema: z.object({
				_id: z.string().default(() => 'k_fixed'),
				title: z.string(),
			}),
		});
		const collection = getCollection(t.db, slugged);
		await collection.sync();
		expect(
			await rejectionMessage(collection.upsert({ title: 'a' } as never, {})),
		).toMatch(/needs "_id" in its filter/);
		// Named in the filter, it seeds the insert and everything holds.
		const written = await collection.upsert({ _id: 'k_mine' } as never, {
			title: 'a',
		});
		expect(written._id).toBe('k_mine');
	});

	test('leaves a stamp given as `undefined` to the collection', async () => {
		const collection = await synced();
		const first = await collection.create({ email: 'ada@example.com' });
		await Bun.sleep(5);
		const again = await collection.upsert({ email: 'ada@example.com' }, {
			updatedAt: undefined,
		} as never);
		// `undefined` says nothing, so it must not count as a stamp the
		// caller wrote — that would freeze `updatedAt` for good.
		expect(again.updatedAt.getTime()).toBeGreaterThan(
			first.updatedAt.getTime(),
		);
	});

	test('names itself when the values are not a document', async () => {
		const collection = await synced();
		expect(
			await rejectionMessage(
				collection.upsert({ email: 'a@b.c' }, null as never),
			),
		).toMatch(/upsert: expected the document's fields, not null/);
	});

	test('does not credit itself with a document it did not create', async () => {
		// `$_id` is missing on an insert and there on an update — measured —
		// so an absent `createdBy` is left absent rather than filled with
		// whoever happened to match the document.
		const loose = defineCollection({
			name: 'loose-actors',
			validation: { level: 'off' },
			schema: z.object({ _id: id(), slug: z.string() }),
			actors: true,
		});
		const collection = getCollection(t.db, loose);
		await collection.sync();
		await t.db.collection('loose-actors').insertOne({ slug: 'a' });
		const actor = new ObjectId();
		const upserted = await collection.as(actor).upsert({ slug: 'a' }, {});
		expect(upserted.createdBy).toBeUndefined();
		expect(upserted.updatedBy).toEqual(actor);
		// And it still stamps the one it does create.
		const made = await collection.as(actor).upsert({ slug: 'b' }, {});
		expect(made.createdBy).toEqual(actor);
	});

	test('leaves a field the stored document is missing alone', async () => {
		const defaulted = defineCollection({
			name: 'holes',
			validation: { level: 'off' },
			schema: z.object({
				_id: id(),
				slug: z.string(),
				tags: z.array(z.string()).default([]),
			}),
		});
		const collection = getCollection(t.db, defaulted);
		await collection.sync();
		await t.db.collection('holes').insertOne({ slug: 'a' });
		const upserted = await collection.upsert({ slug: 'a' }, {});
		// `update` fills no default, and neither does this half.
		expect(upserted.tags).toBeUndefined();
		// The insert still lands the default, as `create` does.
		expect((await collection.upsert({ slug: 'b' }, {})).tags).toEqual([]);
	});

	test('falls back to the field itself when the filter names `_id`', async () => {
		// The one case with no signal: the server seeds `_id` from the filter,
		// so `$_id` is there on both halves. A collection keyed by a string
		// `_id` has to name it, and pays the fallback the Traps describe.
		const keyed = defineCollection({
			name: 'keyed',
			validation: { level: 'off' },
			schema: z.object({
				_id: z.string(),
				slug: z.string(),
				status: z.string().nullable().default('new'),
			}),
			actors: true,
		});
		const collection = getCollection(t.db, keyed);
		await collection.sync();
		await t.db
			.collection<{ _id: string; slug: string; status: string | null }>('keyed')
			.insertOne({ _id: 'k', slug: 'a', status: null });
		const actor = new ObjectId();
		const upserted = await collection
			.as(actor)
			.upsert({ _id: 'k' } as never, { slug: 'b' });
		expect(upserted.slug).toBe('b');
		// The fallback fills what is **absent** — here, `createdBy`…
		expect(upserted.createdBy).toEqual(actor);
		// …and still never mistakes a stored `null` for an absence.
		expect(upserted.status).toBe(null);
	});
});

describe('a server that answers an upsert with nothing', () => {
	/**
	 * The same database, with `findOneAndUpdate` answering no document.
	 *
	 * MongoDB does not do this — the branch exists because "does not" is not
	 * "cannot": a proxy, a driver bug or a version that stops sending
	 * `lastErrorObject` would all arrive here. Proxying the `Db` is how
	 * `gridfs.spec.ts` makes the driver behave unusually, so it is how this
	 * one does too.
	 */
	function mute(db: Db): Db {
		return new Proxy(db, {
			get(target, key, receiver) {
				if (key !== 'collection') return Reflect.get(target, key, receiver);
				return (name: string, ...rest: unknown[]) => {
					const real = (
						target.collection as (n: string, ...r: unknown[]) => Collection
					)(name, ...rest);
					return new Proxy(real, {
						get(inner, member, self) {
							if (member !== 'findOneAndUpdate') {
								return Reflect.get(inner, member, self);
							}
							return async () => ({ value: null, lastErrorObject: {} });
						},
					});
				};
			},
		});
	}

	test('says so, names the collection, and is not a TypeError', async () => {
		const collection = getCollection(mute(t.db), users);
		const error = await collection
			.upsert({ email: 'ada@example.com' }, { name: 'Ada' })
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);
		// A `DataError`, not the `TypeError` the refusals of the same call
		// throw: those are the caller's mistake and this one cannot be, and
		// they used to wear the same class and the same `upsert: "users"`
		// prefix.
		expect(error).toBeInstanceOf(DataError);
		expect(error).not.toBeInstanceOf(TypeError);
		expect(error).toHaveProperty('code', 'DATABASE');
		expect(error).toHaveProperty('collection', 'users');
		expect((error as Error).message).toBe(
			'upsert on "users" was answered with no document, although MongoDB ' +
				'answers an upsert with the document it matched or inserted. ' +
				'Nothing was stored. This is a bug in @nxgt/mongo or something ' +
				'rewriting replies between the process and the server: report it ' +
				'at https://github.com/softistx/nxgt-data/issues',
		);
	});
});

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { ObjectId } from 'mongodb';
import { rejection, rejectionMessage } from '../../test/rejection';
import { tickets, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { NotFoundError, OptimisticLockError } from '../errors/data-error';
import { withTransaction } from '../transaction/with-transaction';
import { getCollection } from './get-collection';
import type { CollectionHooks } from './hooks/types';

// The stamps are the collection's: a write may give the timestamps it is
// allowed to, and nothing else. The compile-time half is in
// `test/types/stamp-writes.ts`; this is the half a caller the types do not
// reach runs into.

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(async () => {
	await t.reset();
	await getCollection(t.db, users).sync();
	await getCollection(t.db, tickets).sync();
});
afterAll(() => t.stop());

const stored = (name: string) => t.db.collection(name).find().toArray();
const loose = (values: object) => values as never;
const kept = (name: string) => `"${name}" is kept by`;
const at = new Date('2020-01-02T03:04:05Z');

describe('create', () => {
	test('fills every stamp when none is given', async () => {
		const ada = await getCollection(t.db, users).create({
			email: 'ada@example.com',
		});
		expect(ada.createdAt).toBeInstanceOf(Date);
		expect(ada.updatedAt).toBeInstanceOf(Date);
		expect(ada.version).toBe(0);
		expect(ada.deletedAt).toBeNull();
	});

	test('keeps the timestamps it is given', async () => {
		const ada = await getCollection(t.db, users).create({
			email: 'ada@example.com',
			createdAt: at,
			updatedAt: at,
		});
		expect(ada.createdAt).toEqual(at);
		expect((await stored('users'))[0]?.['createdAt']).toEqual(at);
		expect((await stored('users'))[0]?.['updatedAt']).toEqual(at);
	});

	test.each([
		['version', 3],
		['deletedAt', at],
		['createdBy', new ObjectId()],
		['updatedBy', null],
		['deletedBy', null],
	])('refuses %s, and writes nothing', async (name, value) => {
		const collection = getCollection(t.db, users);
		const values = loose({ email: 'ada@example.com', [name]: value });
		expect(await rejectionMessage(collection.create(values))).toContain(
			`create: ${kept(name)} "users" itself`,
		);
		expect(await rejectionMessage(collection.createMany([values]))).toContain(
			kept(name),
		);
		expect(await stored('users')).toEqual([]);
	});

	test('refuses them under the names the collection gives them', async () => {
		const collection = getCollection(t.db, tickets);
		for (const name of ['revision', 'removedAt', 'openedBy', 'updatedBy']) {
			expect(
				await rejectionMessage(
					collection.create(loose({ subject: 'a', [name]: 1 })),
				),
			).toContain(kept(name));
		}
		// `deletedBy` is off here: not a kept field, just one the schema drops.
		const ticket = await collection.create(
			loose({ subject: 'a', deletedBy: null }),
		);
		expect(ticket).not.toHaveProperty('deletedBy');
	});

	test('a stamp given as undefined is no stamp at all', async () => {
		const ada = await getCollection(t.db, users).create(
			loose({ email: 'ada@example.com', version: undefined }),
		);
		expect(ada.version).toBe(0);
	});

	test('the actor comes from `as`', async () => {
		const actor = new ObjectId();
		const collection = getCollection(t.db, users).as(actor);
		const ada = await collection.create({ email: 'ada@example.com' });
		expect(ada.createdBy).toEqual(actor);
		expect(
			await rejectionMessage(
				collection.create(loose({ email: 'b@example.com', createdBy: actor })),
			),
		).toContain(kept('createdBy'));
	});

	test('a hook cannot slip a stamp in', async () => {
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeCreate: ({ values }) => ({
					values: loose({ ...values, version: 9 }),
				}),
			},
		});
		expect(
			await rejectionMessage(collection.create({ email: 'ada@example.com' })),
		).toContain(kept('version'));
	});
});

describe('update', () => {
	async function seed() {
		const collection = getCollection(t.db, users);
		const ada = await collection.create({ email: 'ada@example.com' });
		return { collection, ada };
	}

	test('keeps the updated stamp it is given', async () => {
		const { collection, ada } = await seed();
		const updated = await collection.update(ada._id, {
			name: 'Ada',
			updatedAt: at,
		});
		expect(updated.updatedAt).toEqual(at);
		const viaSet = await collection.update(ada._id, {
			$set: { name: 'A', updatedAt: at },
		});
		expect(viaSet.updatedAt).toEqual(at);
	});

	test('a stamp given as undefined is not written, and updatedAt is touched', async () => {
		const collection = getCollection(t.db, users);
		const ada = await collection.create({
			email: 'ada@example.com',
			updatedAt: at,
		});
		const updated = await collection.update(
			ada._id,
			loose({ name: 'Ada', updatedAt: undefined, deletedAt: undefined }),
		);
		expect(updated.updatedAt).not.toEqual(at);
		expect(updated.deletedAt).toBeNull();
	});

	test.each([
		{ $unset: { updatedAt: '' } },
		{ $rename: { updatedAt: 'name' } },
		{ $rename: { name: 'updatedAt' } },
	])('the updated stamp cannot be taken away: %o', async (patch) => {
		const { collection, ada } = await seed();
		expect(
			await rejectionMessage(collection.update(ada._id, loose(patch))),
		).toContain('"updatedAt" is kept by "users" itself and cannot be removed');
		expect((await stored('users'))[0]?.['updatedAt']).toEqual(ada.updatedAt);
	});

	test('a value given as undefined inside an operator says nothing', async () => {
		const { collection, ada } = await seed();
		const updated = await collection.update(
			ada._id,
			loose({
				$set: { name: 'Ada', createdAt: undefined, updatedAt: undefined },
				$unset: { age: undefined },
			}),
		);
		expect(updated.name).toBe('Ada');
		expect(updated.createdAt).toEqual(ada.createdAt);
		expect(updated.updatedAt).toBeInstanceOf(Date);
	});

	test('$currentDate on the updated stamp is left to the server', async () => {
		const { collection, ada } = await seed();
		const updated = await collection.update(ada._id, {
			$currentDate: { updatedAt: true },
		});
		expect(updated.updatedAt).toBeInstanceOf(Date);
		expect(updated.version).toBe(1);
	});

	test.each([
		['createdAt', { createdAt: at }],
		['deletedAt', { deletedAt: at }],
		['createdBy', { createdBy: null }],
		['updatedBy', { updatedBy: null }],
		['deletedBy', { deletedBy: null }],
		['version', { $inc: { version: 5 } }],
		['version', { $set: { version: 5 } }],
		['createdAt', { $set: { 'createdAt.x': 1 } }],
		['deletedAt', { $unset: { deletedAt: '' } }],
		['createdAt', { $currentDate: { createdAt: true } }],
		['deletedAt', { $rename: { name: 'deletedAt' } }],
		['version', { $rename: { name: 'version.x' } }],
		['createdAt', { $rename: { createdAt: 'name' } }],
		['deletedAt', { $push: { 'deletedAt.x': 1 } }],
		['createdAt', { $set: { createdAt: at }, $inc: { age: 1 } }],
		['createdAt', { $set: { name: 'x', createdAt: undefined }, createdAt: at }],
	])('refuses %s in %o, and writes nothing', async (name, patch) => {
		const { collection, ada } = await seed();
		expect(
			await rejectionMessage(collection.update(ada._id, loose(patch))),
		).toContain(`update: ${kept(name)} "users" itself`);
		expect(
			await rejectionMessage(
				collection.updateMany({ _id: ada._id }, loose(patch)),
			),
		).toContain(`updateMany: ${kept(name)}`);
		const [document] = await stored('users');
		expect(document?.['version']).toBe(0);
		expect(document?.['createdAt']).toEqual(ada.createdAt);
		expect(document?.['deletedAt']).toBeNull();
	});

	test('refuses them under the names the collection gives them', async () => {
		const collection = getCollection(t.db, tickets);
		const ticket = await collection.create({ subject: 'a' });
		for (const patch of [
			{ removedAt: at },
			{ openedBy: null },
			{ $inc: { revision: 1 } },
			{ $set: { createdAt: at } },
		]) {
			expect(
				await rejectionMessage(collection.update(ticket._id, loose(patch))),
			).toContain('is kept by "tickets" itself');
		}
		expect((await stored('tickets'))[0]?.['revision']).toBe(0);
	});

	test('a hook cannot slip a stamp in', async () => {
		const { ada } = await seed();
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeUpdate: (args) => ({
					...args,
					patch: loose({ ...args.patch, createdAt: at }),
				}),
			},
		});
		expect(
			await rejectionMessage(collection.update(ada._id, { name: 'x' })),
		).toContain(kept('createdAt'));
	});

	test('raw is the way to set a stamp by hand', async () => {
		const { collection, ada } = await seed();
		await collection.raw.updateOne(
			{ _id: ada._id },
			{ $set: { createdAt: at } },
		);
		expect((await collection.getById(ada._id)).createdAt).toEqual(at);
	});
});

describe('a silent update, { audit: false }', () => {
	const silently = { audit: false } as const;

	async function seed(hooks?: CollectionHooks<typeof users>) {
		const collection = getCollection(t.db, users, hooks ? { hooks } : {}).as(
			new ObjectId(),
		);
		const ada = await collection.create({ email: 'ada@example.com' });
		// Let the clock move, so a stamped `updatedAt` could not equal the old one.
		await Bun.sleep(5);
		return { collection, ada };
	}

	test('leaves the version, updatedAt and updatedBy as they were', async () => {
		const { collection, ada } = await seed();
		const updated = await collection
			.as(new ObjectId())
			.update(ada._id, { name: 'Ada' }, silently);
		expect(updated.name).toBe('Ada');
		expect(updated.version).toBe(ada.version);
		expect(updated.updatedAt).toEqual(ada.updatedAt);
		expect(updated.updatedBy).toEqual(ada.updatedBy);
		const [row] = await stored('users');
		expect(row?.['version']).toBe(ada.version);
		expect(row?.['updatedBy']).toEqual(ada.updatedBy);
	});

	test('an update without it still stamps', async () => {
		const { collection, ada } = await seed();
		const updated = await collection.update(ada._id, { name: 'Ada' });
		expect(updated.version).toBe(ada.version + 1);
		expect(updated.updatedAt.getTime()).toBeGreaterThan(
			ada.updatedAt.getTime(),
		);
		const same = await collection.update(
			ada._id,
			{ name: 'A' },
			{
				audit: undefined,
			},
		);
		expect(same.version).toBe(ada.version + 2);
	});

	test('runs the before hooks, which see audit false, and no after hook', async () => {
		const seen: unknown[] = [];
		const after: string[] = [];
		const { collection, ada } = await seed({
			beforeUpdate: (_args, context) => {
				seen.push(context.audit);
			},
			afterUpdate: () => {
				after.push('afterUpdate');
			},
			beforeUpdateMany: (_args, context) => {
				seen.push(context.audit);
			},
			afterUpdateMany: () => {
				after.push('afterUpdateMany');
			},
		});
		await collection.update(ada._id, { name: 'A' }, silently);
		await collection.updateMany({ _id: ada._id }, { name: 'B' }, silently);
		expect(seen).toEqual([false, false]);
		expect(after).toEqual([]);
		await collection.update(ada._id, { name: 'C' });
		expect(seen).toEqual([false, false, true]);
		expect(after).toEqual(['afterUpdate']);
	});

	test('a before-hook guard still applies to a silent updateMany', async () => {
		const { collection } = await seed({
			beforeUpdateMany: ({ filter, patch }) => ({
				filter: { $and: [filter, { email: 'ada@example.com' }] },
				patch,
			}),
		});
		await collection.create({ email: 'bob@example.com' });
		const count = await collection.updateMany(
			{ _id: { $exists: true } },
			{ name: 'Scoped' },
			silently,
		);
		expect(count).toBe(1);
		const names = Object.fromEntries(
			(await stored('users')).map((u) => [u['email'], u['name']]),
		);
		expect(names).toEqual({
			'ada@example.com': 'Scoped',
			'bob@example.com': null,
		});
	});

	test('runs in the transaction and rolls back with it', async () => {
		const { collection, ada } = await seed();
		const failure = await rejectionMessage(
			withTransaction(t.client, async (session) => {
				const bound = collection.withSession(session);
				await bound.update(ada._id, { name: 'Hidden' }, silently);
				expect((await bound.getById(ada._id)).name).toBe('Hidden');
				throw new Error('abandon');
			}),
		);
		expect(failure).toContain('abandon');
		expect((await collection.getById(ada._id)).name).toBeNull();

		await withTransaction(t.client, async (session) => {
			await collection
				.withSession(session)
				.update(ada._id, { name: 'Kept' }, silently);
		});
		const kept = await collection.getById(ada._id);
		expect(kept.name).toBe('Kept');
		expect(kept.version).toBe(ada.version);
	});

	test('still coerces ids and references', async () => {
		const { collection, ada } = await seed();
		const team = new ObjectId();
		await collection.update(
			ada._id.toHexString(),
			loose({ teamId: team.toHexString() }),
			silently,
		);
		expect((await stored('users'))[0]?.['teamId']).toEqual(team);
		await collection.update(
			ada._id,
			loose({ $set: { teamId: new ObjectId().toHexString() } }),
			silently,
		);
		expect((await stored('users'))[0]?.['teamId']).toBeInstanceOf(ObjectId);
	});

	test('updateMany is silent, and still checks its patch and filter', async () => {
		const { collection, ada } = await seed();
		const count = await collection.updateMany(
			{ email: 'ada@example.com' },
			{ name: 'Many' },
			silently,
		);
		expect(count).toBe(1);
		const after = await collection.getById(ada._id);
		expect(after.name).toBe('Many');
		expect(after.version).toBe(ada.version);
		expect(after.updatedAt).toEqual(ada.updatedAt);

		expect(
			await rejectionMessage(
				collection.updateMany(
					{ email: 'ada@example.com' },
					loose({ createdAt: new Date() }),
					silently,
				),
			),
		).toContain(kept('createdAt'));
		expect(
			await rejectionMessage(
				collection.updateMany({}, { name: 'x' }, silently),
			),
		).toContain('updateMany needs a filter');
		expect(
			await rejectionMessage(
				collection.updateMany(
					{ email: 'ada@example.com' },
					loose({ version: 0 }),
					silently,
				),
			),
		).toContain('version');
	});

	test('refuses _id, as a loud update does', async () => {
		const { collection, ada } = await seed();
		expect(
			await rejectionMessage(
				collection.update(ada._id, loose({ _id: new ObjectId() }), silently),
			),
		).toContain('"_id" is immutable');
		expect(
			await rejectionMessage(
				collection.updateMany(
					{ _id: ada._id },
					loose({ $set: { _id: new ObjectId() } }),
					silently,
				),
			),
		).toContain('"_id" is immutable');
	});

	test('refuses a session, pointing to withSession', async () => {
		const { collection, ada } = await seed();
		const message = await rejectionMessage(
			collection.update(
				ada._id,
				{ name: 'x' },
				loose({ session: t.client.startSession() }),
			),
		);
		expect(message).toContain('withSession(session)');
		expect(
			await rejectionMessage(
				collection.updateMany(
					{ _id: ada._id },
					{ name: 'x' },
					loose({ session: null }),
				),
			),
		).toContain('withSession(session)');
	});

	test('writes a soft-deleted document no more than a loud update does', async () => {
		const { collection, ada } = await seed();
		await collection.delete(ada._id);
		expect(
			await rejection(collection.update(ada._id, { name: 'x' }, silently)),
		).toBeInstanceOf(NotFoundError);
		expect(
			await collection.updateMany({ _id: ada._id }, { name: 'x' }, silently),
		).toBe(0);
	});

	test('the lock does not see a silent write', async () => {
		const { collection, ada } = await seed();
		// Two silent updates at the same version both succeed…
		await collection.update(
			ada._id,
			{ name: 'one', version: ada.version },
			silently,
		);
		await collection.update(
			ada._id,
			{ name: 'two', version: ada.version },
			silently,
		);
		expect((await collection.getById(ada._id)).name).toBe('two');
		// …and a normal one at the version read before them still does.
		const updated = await collection.update(ada._id, {
			name: 'loud',
			version: ada.version,
		});
		expect(updated.version).toBe(ada.version + 1);
		expect(updated.name).toBe('loud');
		// A stale expected version is still refused, silent or not.
		const error = await rejection(
			collection.update(ada._id, { name: 'x', version: ada.version }, silently),
		);
		expect(error).toBeInstanceOf(OptimisticLockError);
	});
});

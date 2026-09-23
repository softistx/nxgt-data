import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { ObjectId } from 'mongodb';
import { rejectionMessage } from '../../test/rejection';
import { tickets, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { getCollection } from './get-collection';

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
		expect((await stored('users'))[0]?.createdAt).toEqual(at);
		expect((await stored('users'))[0]?.updatedAt).toEqual(at);
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
		expect((await stored('users'))[0]?.updatedAt).toEqual(ada.updatedAt);
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
		expect(document?.version).toBe(0);
		expect(document?.createdAt).toEqual(ada.createdAt);
		expect(document?.deletedAt).toBeNull();
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
		expect((await stored('tickets'))[0]?.revision).toBe(0);
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

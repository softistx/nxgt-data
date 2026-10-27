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
import { users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { withTransaction } from '../transaction/with-transaction';
import { getCollection } from './get-collection';
import type { CollectionHooks } from './hooks/types';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo('nxgt-silent');
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

async function seed(hooks?: CollectionHooks<typeof users>) {
	const base = getCollection(t.db, users, hooks ? { hooks } : {});
	await base.sync();
	const collection = base.as(new ObjectId());
	const ada = await collection.create({ email: 'ada@example.com' });
	// Let the clock move, so a stamped `updatedAt` could not equal the old one.
	await Bun.sleep(5);
	return { collection, ada };
}

describe('silent update (audit: false)', () => {
	test('leaves version, updatedAt and updatedBy as they were', async () => {
		const { collection, ada } = await seed();
		const other = collection.as(new ObjectId());
		const updated = await other.update(
			ada._id,
			{ name: 'Ada' },
			{ audit: false },
		);
		expect(updated.name).toBe('Ada');
		expect(updated.version).toBe(ada.version);
		expect(updated.updatedAt).toEqual(ada.updatedAt);
		expect(updated.updatedBy).toEqual(ada.updatedBy);
		const stored = await t.db.collection('users').findOne({ _id: ada._id });
		expect(stored?.['version']).toBe(ada.version);
		expect(stored?.['updatedBy']).toEqual(ada.updatedBy);
	});

	test('a normal update still stamps', async () => {
		const { collection, ada } = await seed();
		const updated = await collection.update(ada._id, { name: 'Ada' });
		expect(updated.version).toBe(ada.version + 1);
		expect(updated.updatedAt.getTime()).toBeGreaterThan(
			ada.updatedAt.getTime(),
		);
	});

	test('runs no hook, so nothing in the process is told', async () => {
		const calls: string[] = [];
		const { collection, ada } = await seed({
			beforeUpdate: () => {
				calls.push('before');
			},
			afterUpdate: () => {
				calls.push('after');
			},
			beforeUpdateMany: () => {
				calls.push('beforeMany');
			},
			afterUpdateMany: () => {
				calls.push('afterMany');
			},
		});
		await collection.update(ada._id, { name: 'A' }, { audit: false });
		await collection.updateMany(
			{ _id: { $exists: true } },
			{ name: 'B' },
			{ audit: false },
		);
		expect(calls).toEqual([]);
		await collection.update(ada._id, { name: 'C' });
		expect(calls).toEqual(['before', 'after']);
	});

	test('writes in the transaction and rolls back with it', async () => {
		const { collection, ada } = await seed();
		const failure = await rejectionMessage(
			withTransaction(t.client, async (session) => {
				await collection
					.withSession(session)
					.update(ada._id, { name: 'Hidden' }, { audit: false });
				const inside = await collection.withSession(session).getById(ada._id);
				expect(inside.name).toBe('Hidden');
				throw new Error('abandon');
			}),
		);
		expect(failure).toContain('abandon');
		expect((await collection.getById(ada._id)).name).toBeNull();

		await withTransaction(t.client, async (session) => {
			await collection
				.withSession(session)
				.update(ada._id, { name: 'Kept' }, { audit: false });
		});
		const kept = await collection.getById(ada._id);
		expect(kept.name).toBe('Kept');
		expect(kept.version).toBe(ada.version);
	});

	test('still coerces ids, for a string id and a string reference', async () => {
		const { collection, ada } = await seed();
		const team = new ObjectId();
		await collection.update(
			ada._id.toHexString(),
			{ teamId: team.toHexString() as never },
			{ audit: false },
		);
		const stored = await t.db.collection('users').findOne({ _id: ada._id });
		expect(stored?.['teamId']).toBeInstanceOf(ObjectId);
		expect(String(stored?.['teamId'])).toBe(team.toHexString());
		await collection.update(
			ada._id,
			{ $set: { teamId: team.toHexString() as never } },
			{ audit: false },
		);
		expect(
			(await t.db.collection('users').findOne({ _id: ada._id }))?.['teamId'],
		).toBeInstanceOf(ObjectId);
	});

	test('updateMany is silent too, and still checks the patch', async () => {
		const { collection, ada } = await seed();
		const count = await collection.updateMany(
			{ email: 'ada@example.com' },
			{ name: 'Many' },
			{ audit: false },
		);
		expect(count).toBe(1);
		const after = await collection.getById(ada._id);
		expect(after.name).toBe('Many');
		expect(after.version).toBe(ada.version);
		expect(after.updatedAt).toEqual(ada.updatedAt);
		expect(
			await rejectionMessage(
				collection.update(ada._id, { createdAt: new Date() } as never, {
					audit: false,
				}),
			),
		).toContain('createdAt');
	});

	test('an expected version still guards a silent update, without bumping', async () => {
		const { collection, ada } = await seed();
		await collection.update(
			ada._id,
			{ name: 'Ada', version: ada.version },
			{ audit: false },
		);
		const error = await collection
			.update(
				ada._id,
				{ name: 'x', version: ada.version + 5 },
				{ audit: false },
			)
			.catch((e) => e);
		expect(error.code).toBe('OPTIMISTIC_LOCK');
		expect((await collection.getById(ada._id)).version).toBe(ada.version);
	});
});

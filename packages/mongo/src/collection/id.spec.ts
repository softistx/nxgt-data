import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { z } from 'zod';
import { posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { defineCollection } from '../definition/define-collection';
import { id } from '../definition/fields';
import { getCollection } from './get-collection';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

async function seed() {
	const collection = getCollection(t.db, users);
	await collection.sync();
	const ada = await collection.create({ email: 'ada@example.com' });
	return { collection, ada };
}

describe('the id of a document', () => {
	test('is _id as a string, on everything a collection gives back', async () => {
		const { collection, ada } = await seed();
		expect(ada.id).toBe(ada._id.toHexString());

		expect((await collection.getById(ada._id)).id).toBe(ada.id);
		expect((await collection.findById(ada._id))?.id).toBe(ada.id);
		expect((await collection.findFirst({ email: 'ada@example.com' }))?.id).toBe(
			ada.id,
		);
		expect((await collection.findMany())[0]?.id).toBe(ada.id);
		expect((await collection.paginate()).items[0]?.id).toBe(ada.id);
		expect((await collection.paginateByCursor()).items[0]?.id).toBe(ada.id);
		expect((await collection.update(ada._id, { name: 'Ada' })).id).toBe(ada.id);
		expect((await collection.delete(ada._id)).id).toBe(ada.id);
		expect((await collection.restore(ada._id)).id).toBe(ada.id);
		expect((await collection.hardDelete(ada._id)).id).toBe(ada.id);
	});

	test('createMany gives one to each', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		const created = await collection.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect(created.map((post) => post.id)).toEqual(
			created.map((post) => post._id.toHexString()),
		);
	});

	test('is carried by JSON and by a spread, so a handler can return it', async () => {
		const { ada } = await seed();
		const asJson = JSON.parse(JSON.stringify(ada)) as Record<string, unknown>;
		expect(asJson.id).toBe(ada.id);
		expect({ ...ada }.id).toBe(ada.id);
		expect(Object.keys(ada)).toContain('id');
	});

	test('is computed, never stored', async () => {
		const { ada } = await seed();
		const stored = await t.db.collection('users').findOne({ _id: ada._id });
		expect(stored).not.toBeNull();
		expect(Object.hasOwn(stored as object, 'id')).toBe(false);
	});

	test('a document that was read can be written back', async () => {
		const { collection, ada } = await seed();
		const read = await collection.getById(ada._id);
		// The schema strips `id`, so the copy is inserted without it.
		const copy = await collection.create({
			...read,
			_id: undefined as never,
			email: 'copy@example.com',
		});
		expect(copy._id).not.toEqual(ada._id);
		expect(
			Object.hasOwn(
				(await t.db.collection('users').findOne({ _id: copy._id })) as object,
				'id',
			),
		).toBe(false);
	});

	test('validate: off does not parse, and still writes no id', async () => {
		const { collection, ada } = await seed();
		const read = await collection.getById(ada._id);
		const raw = getCollection(t.db, users, { validate: 'off' });
		// Nothing strips the field here: `toDocument` is what drops it, and
		// without it the collection's validator would refuse the document.
		const written = await raw.create({
			...read,
			_id: undefined as never,
			email: 'copy@example.com',
		} as never);
		const stored = await t.db
			.collection('users')
			.findOne({ email: 'copy@example.com' });
		expect(stored).not.toBeNull();
		expect(Object.hasOwn(stored as object, 'id')).toBe(false);
		expect(written).toBeDefined();
	});

	test('a projection without _id gets none', async () => {
		const { collection } = await seed();
		const [projected] = await collection.findMany({
			projection: { email: 1, _id: 0 },
		});
		expect(projected).toEqual({ email: 'ada@example.com' } as never);
		expect(Object.hasOwn(projected as object, 'id')).toBe(false);
	});

	test('a schema with an id field of its own keeps it', async () => {
		const things = defineCollection({
			name: 'things',
			schema: z.object({ _id: id(), id: z.string() }),
		});
		const collection = getCollection(t.db, things);
		await collection.sync();

		const thing = await collection.create({ id: 'mine' });
		expect(thing.id).toBe('mine');
		// It is a field like any other: stored, and read back as it was.
		const stored = await t.db.collection('things').findOne({ _id: thing._id });
		expect(stored?.id).toBe('mine');
		expect((await collection.getById(thing._id)).id).toBe('mine');
	});
});

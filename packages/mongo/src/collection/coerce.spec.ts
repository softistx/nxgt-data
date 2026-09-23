import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { rejection } from '../../test/rejection';
import { users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { defineCollection } from '../definition/define-collection';
import { id, objectId } from '../definition/fields';
import { bsonKindOf, coerceValue, kindsOf } from './coerce';
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

describe('what a field is known to hold', () => {
	test('reads the bsonType through every wrapper', () => {
		// Measured on zod 4.6.5: `.meta()` does not travel through `optional`,
		// `nullable`, `default`, `catch` or `readonly`, so the metadata has to
		// be read under them rather than on them.
		expect(bsonKindOf(objectId())).toBe('objectId');
		expect(bsonKindOf(objectId().optional())).toBe('objectId');
		expect(bsonKindOf(objectId().nullable().default(null))).toBe('objectId');
		expect(bsonKindOf(id())).toBe('objectId');
		expect(bsonKindOf(z.date())).toBe('date');
		expect(bsonKindOf(z.date().nullable())).toBe('date');
		expect(bsonKindOf(z.string())).toBeUndefined();
		expect(bsonKindOf(z.int())).toBeUndefined();
	});

	test('collapses an array to what it holds, so $in needs no rule of its own', () => {
		expect(bsonKindOf(z.array(objectId()))).toBe('objectId');
		expect(bsonKindOf(z.array(z.date()).default([]))).toBe('date');
	});

	test('names a nested field by the path a filter spells', () => {
		const kinds = kindsOf({
			_id: id(),
			author: z.object({ id: objectId(), joined: z.date() }),
			title: z.string(),
		});
		expect(kinds).toEqual({
			_id: 'objectId',
			'author.id': 'objectId',
			'author.joined': 'date',
		});
	});
});

describe('what a value becomes', () => {
	test('turns the string forms into what is stored', () => {
		const hex = '507f1f77bcf86cd799439011';
		expect(coerceValue('objectId', hex)).toEqual(new ObjectId(hex));
		expect(coerceValue('date', '2026-01-02T03:04:05.000Z')).toEqual(
			new Date('2026-01-02T03:04:05.000Z'),
		);
	});

	test('never guesses: what it cannot read, it hands on untouched', () => {
		// A refusal by the schema, with the schema's own message, beats a
		// value this invented.
		expect(coerceValue('objectId', 'not-an-id')).toBe('not-an-id');
		expect(coerceValue('objectId', '507f1f77bcf86cd79943901')).toBe(
			'507f1f77bcf86cd79943901',
		);
		expect(coerceValue('date', 'someday')).toBe('someday');
	});

	test('a date is only the shape that means one thing everywhere', () => {
		// Every one of these is something `new Date` reads happily, and none
		// of them means one instant — measured on bun 1.4.2.
		expect(coerceValue('date', '5')).toBe('5'); // else 2001-05-01, locally
		expect(coerceValue('date', '2026')).toBe('2026'); // else the 1st of Jan
		expect(coerceValue('date', '2026-02-31')).toBe('2026-02-31'); // else Mar 3
		// No zone: 05:00Z here, 23:00Z the day before in Sydney.
		expect(coerceValue('date', '2026-01-01T00:00')).toBe('2026-01-01T00:00');
		expect(coerceValue('date', '2026-01-01T25:00:00Z')).toBe(
			'2026-01-01T25:00:00Z',
		);
		// And what it does read.
		expect(coerceValue('date', '2026-01-01')).toEqual(
			new Date('2026-01-01T00:00:00.000Z'),
		);
		expect(coerceValue('date', '2026-01-01T00:00:00.000+02:00')).toEqual(
			new Date('2025-12-31T22:00:00.000Z'),
		);
	});

	test('a number is not a date', () => {
		// Epoch seconds and epoch milliseconds read the same and differ by a
		// thousand, so neither is chosen.
		expect(coerceValue('date', 1_767_312_245)).toBe(1_767_312_245);
	});

	test('leaves a value that is already what it should be', () => {
		const oid = new ObjectId();
		const date = new Date();
		expect(coerceValue('objectId', oid)).toBe(oid);
		expect(coerceValue('date', date)).toBe(date);
	});
});

describe('a filter', () => {
	test('finds by the string form of an id', async () => {
		const { collection, ada } = await seed();
		expect(await collection.findById(ada.id)).toMatchObject({
			email: 'ada@example.com',
		});
		expect(await collection.findFirst({ _id: ada.id })).toMatchObject({
			email: 'ada@example.com',
		});
	});

	test('keeps an ObjectId whole', async () => {
		const { collection, ada } = await seed();
		// The regression this guards: an `ObjectId` is a non-array object, so
		// a walk that treats every object as a bag of operators turns it into
		// `{ i0, i1, … }` and the filter matches nothing at all.
		expect(await collection.findById(ada._id)).toMatchObject({
			email: 'ada@example.com',
		});
	});

	test('reads the strings inside $in and $nin', async () => {
		const { collection, ada } = await seed();
		const other = await collection.create({ email: 'bob@example.com' });
		const found = await collection.findMany({
			filter: { _id: { $in: [ada.id, other.id] } as never },
		});
		expect(found.map((one) => one.email).sort()).toEqual([
			'ada@example.com',
			'bob@example.com',
		]);
		expect(await collection.count({ _id: { $nin: [ada.id] } as never })).toBe(
			1,
		);
	});

	test('reads a date string under a range operator', async () => {
		const { collection } = await seed();
		const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
		expect(
			await collection.count({ createdAt: { $lt: tomorrow } as never }),
		).toBe(1);
		expect(
			await collection.count({ createdAt: { $gt: tomorrow } as never }),
		).toBe(0);
	});

	test('reaches into $and and $or', async () => {
		const { collection, ada } = await seed();
		expect(
			await collection.count({
				$or: [{ _id: ada.id as never }, { email: 'nobody@example.com' }],
			}),
		).toBe(1);
	});

	test('leaves an operand that is not a value of its field', async () => {
		const { collection } = await seed();
		// `$exists` takes a boolean, `$type` a type name: neither is an id,
		// whatever the field holds.
		expect(await collection.count({ _id: { $exists: true } })).toBe(1);
		expect(await collection.count({ teamId: { $type: 'null' } as never })).toBe(
			1,
		);
	});
});

describe('a write', () => {
	test('takes the string form of an id and of a date', async () => {
		const { collection } = await seed();
		const team = new ObjectId();
		const written = await collection.create({
			email: 'grace@example.com',
			teamId: team.toHexString(),
		});
		expect(written.teamId).toEqual(team);
		// It is stored as an ObjectId, not as a string: a filter by the real
		// thing finds it.
		expect(await collection.count({ teamId: team })).toBe(1);
	});

	test('takes them in a patch too', async () => {
		const { collection, ada } = await seed();
		const team = new ObjectId();
		const updated = await collection.update(ada._id, {
			teamId: team.toHexString(),
		});
		expect(updated.teamId).toEqual(team);
	});

	test('still refuses what it could not read', async () => {
		const { collection } = await seed();
		// Handed on as the string it is, so the schema says why.
		expect(
			await rejection(
				collection.create({
					email: 'eve@example.com',
					teamId: 'not-an-id',
				}),
			),
		).toBeInstanceOf(Error);
	});
});

describe("a patch written in MongoDB's operators", () => {
	test('reads the strings inside $set', async () => {
		const { collection, ada } = await seed();
		const team = new ObjectId();
		// The other branch goes through `setFromFields`; this one used to be
		// handed to the driver untouched, so the same value converted or not
		// depending on how the patch was written.
		await collection.update(ada._id, { $set: { teamId: team.toHexString() } });
		expect(await collection.count({ teamId: team })).toBe(1);
	});

	test('reads them inside $push and its $each', async () => {
		const withTags = defineCollection({
			name: 'tagged',
			schema: z.object({
				_id: id(),
				seen: z.array(z.date()).default([]),
			}),
		});
		const collection = getCollection(t.db, withTags);
		await collection.sync();
		const written = await collection.create({});
		await collection.update(written._id, {
			$push: { seen: { $each: ['2026-01-01T00:00:00.000Z'] } },
		});
		const read = await collection.getById(written._id);
		expect(read.seen[0]).toBeInstanceOf(Date);
	});
});

describe('a filter that reaches into an array of documents', () => {
	const posts = defineCollection({
		name: 'authored',
		schema: z.object({
			_id: id(),
			authors: z.array(z.object({ id: objectId() })).default([]),
		}),
	});

	test('reads $elemMatch with the kinds inside the array', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		const author = new ObjectId();
		await collection.create({ authors: [{ id: author }] });
		// The dotted path and `$elemMatch` name the same thing, so they have
		// to read the same: one converting and not the other is the trap.
		expect(await collection.count({ 'authors.id': author.toHexString() })).toBe(
			1,
		);
		expect(
			await collection.count({
				authors: { $elemMatch: { id: author.toHexString() } },
			}),
		).toBe(1);
	});
});

describe('a hard delete', () => {
	test('reads a string id, as a soft delete does', async () => {
		const { collection, ada } = await seed();
		// `hardDeleteMany` is scoped to nothing on purpose and so skipped the
		// one funnel every other filter goes through.
		expect(await collection.hardDeleteMany({ _id: ada.id })).toBe(1);
		expect(await collection.count({ _id: { $exists: true } })).toBe(0);
	});
});

describe('a subscription', () => {
	test('reads a string id in its filter', async () => {
		const { collection, ada } = await seed();
		const seen: string[] = [];
		const subscription = collection.onChange(
			(change) => {
				seen.push(String(change.id));
			},
			{ filter: { _id: ada.id } },
		);
		await subscription.ready;
		await collection.update(ada._id, { name: 'Ada' });
		await Bun.sleep(300);
		await subscription.close();
		expect(seen).toEqual([ada.id]);
	});
});

describe('a hook', () => {
	test('is handed the stored form, not the string the caller wrote', async () => {
		const seen: unknown[] = [];
		const collection = getCollection(t.db, users, {
			hooks: {
				beforeUpdate: (args) => {
					// Typed `IdOf<Def>`, so `.equals` has to be there: the
					// collection reads the string before the hook runs.
					seen.push(args.id.equals(ada._id));
				},
			},
		});
		await collection.sync();
		const ada = await collection.create({ email: 'hooked@example.com' });
		await collection.update(ada.id, { name: 'Ada' });
		expect(seen).toEqual([true]);
	});
});

describe('coerce: false', () => {
	const strict = defineCollection({
		name: 'strict',
		schema: z.object({
			_id: id(),
			teamId: objectId().nullable().default(null),
		}),
	});

	test('turns every reading of a string off', async () => {
		const collection = getCollection(t.db, strict, { coerce: false });
		await collection.sync();
		const written = await collection.create({});
		// The filter is sent as written, and an id as a string matches nothing.
		expect(await collection.findById(written.id)).toBeUndefined();
		expect(await collection.findById(written._id)).toMatchObject({
			_id: written._id,
		});
	});
});

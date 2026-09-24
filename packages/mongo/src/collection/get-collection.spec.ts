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
import { logs, posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import {
	ConflictError,
	NotFoundError,
	ValidationError,
} from '../errors/data-error';
import { getCollection } from './get-collection';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** The three repositories, on collections that exist. */
async function collections() {
	const all = {
		users: getCollection(t.db, users),
		posts: getCollection(t.db, posts),
		logs: getCollection(t.db, logs),
	};
	await Promise.all([all.users.sync(), all.posts.sync(), all.logs.sync()]);
	return all;
}

describe('create and read', () => {
	test('create fills the schema’s defaults and returns the document', async () => {
		const { users: collection } = await collections();
		const ada = await collection.create({ email: 'ada@example.com' });
		expect(ada._id).toBeInstanceOf(ObjectId);
		expect(ada.email).toBe('ada@example.com');
		expect(ada.name).toBeNull();
		expect(ada.createdAt).toBeInstanceOf(Date);
		expect(ada.deletedAt).toBeNull();
		expect(ada.version).toBe(0);
		// It is the document that is stored, not a shape of our own — `id`
		// apart, which is computed from `_id` and stored nowhere.
		expect(ada.id).toBe(ada._id.toHexString());
		const stored = await t.db.collection('users').findOne({ _id: ada._id });
		expect({ ...stored, id: ada.id }).toEqual(ada as never);
	});

	test('create refuses a document the schema refuses, before sending it', async () => {
		const { users: collection } = await collections();
		expect(
			await rejectionMessage(collection.create({ email: 'not-an-email' })),
		).toMatch(/Invalid email/);
		expect(await collection.count()).toBe(0);
	});

	test('createMany inserts in one go, and [] sends nothing', async () => {
		const { posts: collection } = await collections();
		const created = await collection.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect(created.map((post) => post.title)).toEqual(['a', 'b']);
		expect(created[0]?.tags).toEqual([]);
		expect(await collection.createMany([])).toEqual([]);
		expect(await collection.count()).toBe(2);
	});

	test('findById and getById', async () => {
		const { users: collection } = await collections();
		const ada = await collection.create({ email: 'ada@example.com' });
		expect(await collection.findById(ada._id)).toEqual(ada);
		expect(await collection.getById(ada._id)).toEqual(ada);

		const missing = new ObjectId();
		expect(await collection.findById(missing)).toBeUndefined();
		const error = await collection.getById(missing).catch((e) => e);
		expect(error).toBeInstanceOf(NotFoundError);
		expect(error.message).toBe(`No document in "users" with _id ${missing}`);
		expect(error.collection).toBe('users');
		expect(error.id).toEqual(missing);
	});

	test('findFirst and findMany filter, sort, skip and limit', async () => {
		const { posts: collection } = await collections();
		await collection.createMany([
			{ title: 'a', rank: 2 },
			{ title: 'b', rank: 1 },
			{ title: 'c', rank: 3 },
		]);
		expect((await collection.findFirst({ title: 'b' }))?.rank).toBe(1);
		expect(
			(await collection.findFirst({ rank: { $gt: 1 } }, { sort: { rank: -1 } }))
				?.title,
		).toBe('c');
		expect(await collection.findFirst({ title: 'z' })).toBeUndefined();

		const page = await collection.findMany({
			sort: { rank: 1 },
			skip: 1,
			limit: 1,
		});
		expect(page.map((post) => post.title)).toEqual(['a']);
		expect(
			(await collection.findMany({ projection: { title: 1, _id: 0 } }))[0],
		).toEqual({ title: 'a' } as never);
	});

	test('count and exists', async () => {
		const { posts: collection } = await collections();
		expect(await collection.count()).toBe(0);
		expect(await collection.exists({ title: 'a' })).toBe(false);
		await collection.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 1 },
		]);
		expect(await collection.count()).toBe(2);
		expect(await collection.count({ title: 'a' })).toBe(1);
		expect(await collection.exists({ rank: 1 })).toBe(true);
	});
});

describe('what a read does not do', () => {
	test('applies no $setOnInsert, because no write is an upsert', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		const post = await collection.create({ title: 'a', rank: 1 });
		await collection.update(post._id, {
			$set: { rank: 2 },
			$setOnInsert: { title: 'never' },
		});
		expect(await collection.getById(post._id)).toMatchObject({
			title: 'a',
			rank: 2,
		});
		// And there is no insert for it to apply to: an id that matches
		// nothing is a `NotFoundError`, never a new document.
		expect(
			await rejection(
				collection.update(new ObjectId(), { $setOnInsert: { title: 'x' } }),
			),
		).toBeInstanceOf(NotFoundError);
		expect(await collection.count()).toBe(1);
	});

	test('gives back what the server holds, unchecked', async () => {
		const collection = getCollection(t.db, logs);
		await collection.sync();
		// Written past this package: a migration, another service, or a
		// document from before a field existed. `logs` has no validator, so
		// the server takes it.
		await collection.raw.insertOne({ message: 42 } as never);
		const read = await collection.findFirst();
		// `validate` is about writes: nothing parses a read, so the document
		// comes back typed as the schema says and is not what it says.
		expect(typeof read?.message).toBe('number');
		// What to do about it, when it matters.
		expect(() => logs.schema.parse(read)).toThrow();
	});
});

describe('update', () => {
	test('updates by id, touches updatedAt and raises the version', async () => {
		const { users: collection } = await collections();
		const ada = await collection.create({ email: 'ada@example.com' });
		const updated = await collection.update(ada._id, { name: 'Ada' });
		expect(updated.name).toBe('Ada');
		expect(updated.version).toBe(1);
		expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
			ada.updatedAt.getTime(),
		);
		expect(updated.createdAt).toEqual(ada.createdAt);
	});

	test('checks each field of the patch against the schema', async () => {
		const { users: collection } = await collections();
		const ada = await collection.create({ email: 'ada@example.com' });
		expect(
			await rejectionMessage(
				collection.update(ada._id, { email: 'not-an-email' }),
			),
		).toMatch(/Invalid email/);
		expect(
			await rejectionMessage(collection.update(ada._id, { nope: 1 } as never)),
		).toContain('"users" has no field "nope" in its schema');
		// Nothing was sent: the document is untouched.
		expect((await collection.getById(ada._id)).version).toBe(0);
	});

	test('takes MongoDB’s operators for what a patch cannot say', async () => {
		const { posts: collection } = await collections();
		const post = await collection.create({ title: 'a', rank: 1 });
		const updated = await collection.update(post._id, {
			$inc: { rank: 10 },
			$push: { tags: 'new' },
		});
		expect(updated.rank).toBe(11);
		expect(updated.tags).toEqual(['new']);
	});

	test('throws NotFoundError for an _id that is not there', async () => {
		const { users: collection } = await collections();
		expect(
			await rejection(collection.update(new ObjectId(), { name: 'x' })),
		).toBeInstanceOf(NotFoundError);
	});

	test('updateMany updates what matches and needs a filter', async () => {
		const { posts: collection } = await collections();
		await collection.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 1 },
			{ title: 'c', rank: 2 },
		]);
		expect(await collection.updateMany({ rank: 1 }, { title: 'x' })).toBe(2);
		expect(await collection.count({ title: 'x' })).toBe(2);
		expect(
			await rejectionMessage(collection.updateMany({}, { title: 'y' })),
		).toContain('updateMany needs a filter');
		expect(
			await collection.updateMany({ _id: { $exists: true } }, { rank: 5 }),
		).toBe(3);
	});
});

describe('delete, on a collection without soft delete', () => {
	test('delete removes the document and returns it', async () => {
		const { posts: collection } = await collections();
		const post = await collection.create({ title: 'a', rank: 1 });
		expect(await collection.delete(post._id)).toEqual(post);
		expect(await collection.count()).toBe(0);
		expect(await rejection(collection.delete(post._id))).toBeInstanceOf(
			NotFoundError,
		);
	});

	test('deleteMany removes what matches and needs a filter', async () => {
		const { posts: collection } = await collections();
		await collection.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect(await collection.deleteMany({ rank: 1 })).toBe(1);
		expect(await rejectionMessage(collection.deleteMany({}))).toContain(
			'deleteMany needs a filter',
		);
		expect(await collection.count()).toBe(1);
	});

	test('restore throws on a collection without soft delete', async () => {
		const { posts: collection } = await collections();
		expect(
			await rejectionMessage(
				(
					collection as unknown as { restore(id: unknown): Promise<unknown> }
				).restore(new ObjectId()),
			),
		).toContain('has no soft delete');
	});
});

describe('database errors', () => {
	test('a duplicate is a ConflictError with its index and keys', async () => {
		const { users: collection } = await collections();
		await collection.create({ email: 'ada@example.com' });
		const error = await collection
			.create({ email: 'ada@example.com' })
			.catch((e) => e);
		expect(error).toBeInstanceOf(ConflictError);
		expect(error.keys).toEqual(['email']);
		expect(error.values).toEqual({ email: 'ada@example.com' });
		expect(error.index).toBe('users_email_unique');
		expect(error.collection).toBe('users');
	});

	test('a bulk duplicate is one too, from a message with no keyPattern', async () => {
		const { users: collection } = await collections();
		const error = await collection
			.createMany([{ email: 'ada@example.com' }, { email: 'ada@example.com' }])
			.catch((e) => e);
		expect(error).toBeInstanceOf(ConflictError);
		expect(error.keys).toEqual(['email']);
		expect(error.index).toBe('users_email_unique');
		// An ordered insert stops at the one that failed.
		expect(await collection.count()).toBe(1);
	});

	test('the server’s validator is a ValidationError with its issues', async () => {
		const { users: collection } = await collections();
		// `validate: 'off'` sends the document as it is, so the collection's
		// own validator is what refuses it.
		const raw = getCollection(t.db, users, { validate: 'off' });
		const error = await raw
			.create({ _id: new ObjectId(), email: 'not-an-email' } as never)
			.catch((e) => e);
		expect(error).toBeInstanceOf(ValidationError);
		expect(error.serverCode).toBe(121);
		expect(
			error.issues.some((issue: { path: string }) => issue.path === 'email'),
		).toBe(true);
		expect(await collection.count()).toBe(0);
	});

	test('serverCodeName: a write error carries none, a refused command does', async () => {
		const { users: collection } = await collections();
		const ada = await collection.create({ email: 'ada@example.com' });
		const raw = getCollection(t.db, users, { validate: 'off' });

		const one = await raw
			.update(ada._id, { email: 'not-an-email' })
			.catch((e) => e);
		expect(one).toBeInstanceOf(ValidationError);
		expect(one.serverCodeName).toBe('DocumentValidationFailure');

		const many = await raw
			.updateMany({ _id: ada._id }, { email: 'not-an-email' })
			.catch((e) => e);
		expect(many).toBeInstanceOf(ValidationError);
		expect(many.serverCode).toBe(121);
		expect(many.serverCodeName).toBeUndefined();

		// A command refused as a whole is named, whichever method sent it.
		await t.failNext(['update'], { errorCode: 112 });
		const whole = await raw
			.updateMany({ _id: ada._id }, { name: 'Ada' })
			.catch((e) => e);
		expect(whole.serverCode).toBe(112);
		expect(whole.serverCodeName).toBe('WriteConflict');
	});
});

describe('with and as', () => {
	test('as stamps the actor into the *By fields', async () => {
		const { users: collection } = await collections();
		const alice = new ObjectId();
		const bob = new ObjectId();

		const created = await collection
			.as(alice)
			.create({ email: 'ada@example.com' });
		expect(created.createdBy).toEqual(alice);
		expect(created.updatedBy).toEqual(alice);

		const updated = await collection
			.as(bob)
			.update(created._id, { name: 'Ada' });
		expect(updated.createdBy).toEqual(alice);
		expect(updated.updatedBy).toEqual(bob);

		// Without an actor, the fields are left as they are.
		const plain = await collection.update(created._id, { name: 'A' });
		expect(plain.updatedBy).toEqual(bob);
	});

	test('the collection keeps the options it was created with', async () => {
		await collections();
		const small = getCollection(t.db, posts, { maxPageSize: 1 });
		await small.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect((await small.paginate({ pageSize: 10 })).pageSize).toBe(1);
		expect(
			(await small.withSession(undefined).paginate({ pageSize: 10 })).pageSize,
		).toBe(1);
	});

	test('validate: off sends the document as it is, defaults included', async () => {
		const { logs: collection } = await collections();
		const raw = getCollection(t.db, logs, { validate: 'off' });
		// Nothing fills `_id` any more: the driver does, and the schema's other
		// defaults are simply absent.
		const written = await raw.create({ message: 'hi' } as never);
		expect(written.message).toBe('hi');
		expect(await collection.count()).toBe(1);
	});
});

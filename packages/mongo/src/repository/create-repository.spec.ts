import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { ObjectId } from 'mongodb';
import { logs, posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import {
	ConflictError,
	NotFoundError,
	ValidationError,
} from '../errors/data-error';
import { createRepository } from './create-repository';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** The three repositories, on collections that exist. */
async function repos() {
	const all = {
		users: createRepository(t.db, users),
		posts: createRepository(t.db, posts),
		logs: createRepository(t.db, logs),
	};
	await Promise.all([all.users.sync(), all.posts.sync(), all.logs.sync()]);
	return all;
}

describe('create and read', () => {
	test('create fills the schema’s defaults and returns the document', async () => {
		const { users: repo } = await repos();
		const ada = await repo.create({ email: 'ada@example.com' });
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
		const { users: repo } = await repos();
		await expect(repo.create({ email: 'not-an-email' })).rejects.toThrow(
			/Invalid email/,
		);
		expect(await repo.count()).toBe(0);
	});

	test('createMany inserts in one go, and [] sends nothing', async () => {
		const { posts: repo } = await repos();
		const created = await repo.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect(created.map((post) => post.title)).toEqual(['a', 'b']);
		expect(created[0]?.tags).toEqual([]);
		expect(await repo.createMany([])).toEqual([]);
		expect(await repo.count()).toBe(2);
	});

	test('findById and getById', async () => {
		const { users: repo } = await repos();
		const ada = await repo.create({ email: 'ada@example.com' });
		expect(await repo.findById(ada._id)).toEqual(ada);
		expect(await repo.getById(ada._id)).toEqual(ada);

		const missing = new ObjectId();
		expect(await repo.findById(missing)).toBeUndefined();
		const error = await repo.getById(missing).catch((e) => e);
		expect(error).toBeInstanceOf(NotFoundError);
		expect(error.message).toBe(`No document in "users" with _id ${missing}`);
		expect(error.collection).toBe('users');
		expect(error.id).toEqual(missing);
	});

	test('findFirst and findMany filter, sort, skip and limit', async () => {
		const { posts: repo } = await repos();
		await repo.createMany([
			{ title: 'a', rank: 2 },
			{ title: 'b', rank: 1 },
			{ title: 'c', rank: 3 },
		]);
		expect((await repo.findFirst({ title: 'b' }))?.rank).toBe(1);
		expect(
			(await repo.findFirst({ rank: { $gt: 1 } }, { sort: { rank: -1 } }))
				?.title,
		).toBe('c');
		expect(await repo.findFirst({ title: 'z' })).toBeUndefined();

		const page = await repo.findMany({ sort: { rank: 1 }, skip: 1, limit: 1 });
		expect(page.map((post) => post.title)).toEqual(['a']);
		expect(
			(await repo.findMany({ projection: { title: 1, _id: 0 } }))[0],
		).toEqual({ title: 'a' } as never);
	});

	test('count and exists', async () => {
		const { posts: repo } = await repos();
		expect(await repo.count()).toBe(0);
		expect(await repo.exists({ title: 'a' })).toBe(false);
		await repo.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 1 },
		]);
		expect(await repo.count()).toBe(2);
		expect(await repo.count({ title: 'a' })).toBe(1);
		expect(await repo.exists({ rank: 1 })).toBe(true);
	});
});

describe('update', () => {
	test('updates by id, touches updatedAt and raises the version', async () => {
		const { users: repo } = await repos();
		const ada = await repo.create({ email: 'ada@example.com' });
		const updated = await repo.update(ada._id, { name: 'Ada' });
		expect(updated.name).toBe('Ada');
		expect(updated.version).toBe(1);
		expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
			ada.updatedAt.getTime(),
		);
		expect(updated.createdAt).toEqual(ada.createdAt);
	});

	test('checks each field of the patch against the schema', async () => {
		const { users: repo } = await repos();
		const ada = await repo.create({ email: 'ada@example.com' });
		await expect(
			repo.update(ada._id, { email: 'not-an-email' }),
		).rejects.toThrow(/Invalid email/);
		await expect(repo.update(ada._id, { nope: 1 } as never)).rejects.toThrow(
			'"users" has no field "nope" in its schema',
		);
		// Nothing was sent: the document is untouched.
		expect((await repo.getById(ada._id)).version).toBe(0);
	});

	test('takes MongoDB’s operators for what a patch cannot say', async () => {
		const { posts: repo } = await repos();
		const post = await repo.create({ title: 'a', rank: 1 });
		const updated = await repo.update(post._id, {
			$inc: { rank: 10 },
			$push: { tags: 'new' },
		});
		expect(updated.rank).toBe(11);
		expect(updated.tags).toEqual(['new']);
	});

	test('throws NotFoundError for an _id that is not there', async () => {
		const { users: repo } = await repos();
		await expect(
			repo.update(new ObjectId(), { name: 'x' }),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test('updateMany updates what matches and needs a filter', async () => {
		const { posts: repo } = await repos();
		await repo.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 1 },
			{ title: 'c', rank: 2 },
		]);
		expect(await repo.updateMany({ rank: 1 }, { title: 'x' })).toBe(2);
		expect(await repo.count({ title: 'x' })).toBe(2);
		await expect(repo.updateMany({}, { title: 'y' })).rejects.toThrow(
			'updateMany needs a filter',
		);
		expect(await repo.updateMany({ _id: { $exists: true } }, { rank: 5 })).toBe(
			3,
		);
	});
});

describe('delete, on a collection without soft delete', () => {
	test('delete removes the document and returns it', async () => {
		const { posts: repo } = await repos();
		const post = await repo.create({ title: 'a', rank: 1 });
		expect(await repo.delete(post._id)).toEqual(post);
		expect(await repo.count()).toBe(0);
		await expect(repo.delete(post._id)).rejects.toBeInstanceOf(NotFoundError);
	});

	test('deleteMany removes what matches and needs a filter', async () => {
		const { posts: repo } = await repos();
		await repo.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect(await repo.deleteMany({ rank: 1 })).toBe(1);
		await expect(repo.deleteMany({})).rejects.toThrow(
			'deleteMany needs a filter',
		);
		expect(await repo.count()).toBe(1);
	});

	test('restore throws on a collection without soft delete', async () => {
		const { posts: repo } = await repos();
		await expect(
			(repo as unknown as { restore(id: unknown): Promise<unknown> }).restore(
				new ObjectId(),
			),
		).rejects.toThrow('has no soft delete');
	});
});

describe('database errors', () => {
	test('a duplicate is a ConflictError with its index and keys', async () => {
		const { users: repo } = await repos();
		await repo.create({ email: 'ada@example.com' });
		const error = await repo
			.create({ email: 'ada@example.com' })
			.catch((e) => e);
		expect(error).toBeInstanceOf(ConflictError);
		expect(error.keys).toEqual(['email']);
		expect(error.values).toEqual({ email: 'ada@example.com' });
		expect(error.index).toBe('users_email_unique');
		expect(error.collection).toBe('users');
	});

	test('a bulk duplicate is one too, from a message with no keyPattern', async () => {
		const { users: repo } = await repos();
		const error = await repo
			.createMany([{ email: 'ada@example.com' }, { email: 'ada@example.com' }])
			.catch((e) => e);
		expect(error).toBeInstanceOf(ConflictError);
		expect(error.keys).toEqual(['email']);
		expect(error.index).toBe('users_email_unique');
		// An ordered insert stops at the one that failed.
		expect(await repo.count()).toBe(1);
	});

	test('the server’s validator is a ValidationError with its issues', async () => {
		const { users: repo } = await repos();
		// `validate: 'off'` sends the document as it is, so the collection's
		// own validator is what refuses it.
		const raw = createRepository(t.db, users, { validate: 'off' });
		const error = await raw
			.create({ _id: new ObjectId(), email: 'not-an-email' } as never)
			.catch((e) => e);
		expect(error).toBeInstanceOf(ValidationError);
		expect(error.serverCode).toBe(121);
		expect(
			error.issues.some((issue: { path: string }) => issue.path === 'email'),
		).toBe(true);
		expect(await repo.count()).toBe(0);
	});
});

describe('with and as', () => {
	test('as stamps the actor into the *By fields', async () => {
		const { users: repo } = await repos();
		const alice = new ObjectId();
		const bob = new ObjectId();

		const created = await repo.as(alice).create({ email: 'ada@example.com' });
		expect(created.createdBy).toEqual(alice);
		expect(created.updatedBy).toEqual(alice);

		const updated = await repo.as(bob).update(created._id, { name: 'Ada' });
		expect(updated.createdBy).toEqual(alice);
		expect(updated.updatedBy).toEqual(bob);

		// Without an actor, the fields are left as they are.
		const plain = await repo.update(created._id, { name: 'A' });
		expect(plain.updatedBy).toEqual(bob);
	});

	test('the repository keeps the options it was created with', async () => {
		await repos();
		const small = createRepository(t.db, posts, { maxPageSize: 1 });
		await small.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect((await small.paginate({ pageSize: 10 })).pageSize).toBe(1);
		expect(
			(await small.with(undefined).paginate({ pageSize: 10 })).pageSize,
		).toBe(1);
	});

	test('validate: off sends the document as it is, defaults included', async () => {
		const { logs: repo } = await repos();
		const raw = createRepository(t.db, logs, { validate: 'off' });
		// Nothing fills `_id` any more: the driver does, and the schema's other
		// defaults are simply absent.
		const written = await raw.create({ message: 'hi' } as never);
		expect(written.message).toBe('hi');
		expect(await repo.count()).toBe(1);
	});
});

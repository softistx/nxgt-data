// Type tests, checked by `tsc --noEmit` and never run. Each `@ts-expect-error`
// is a call that must not compile: if it compiles, tsc reports the unused
// directive.

import type { Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import type {
	CursorPage,
	DocumentOf,
	IdOf,
	NewDocumentOf,
	Page,
	Repository,
} from '../../src';
import {
	createRepository,
	defineCollection,
	id,
	objectId,
	softDelete,
	timestamps,
	withTransaction,
} from '../../src';
import { posts, type User, users } from '../schema';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const db: Db;

// The documents are the schema's output; a write takes its input.
assertType<Equal<DocumentOf<typeof users>, User>>(true);
assertType<Equal<DocumentOf<typeof users>['_id'], ObjectId>>(true);
assertType<Equal<DocumentOf<typeof users>['createdAt'], Date>>(true);
assertType<Equal<DocumentOf<typeof users>['deletedAt'], Date | null>>(true);
assertType<Equal<IdOf<typeof users>, ObjectId>>(true);
// `_id`, the timestamps and the version have defaults: a write leaves them out.
assertType<Equal<NewDocumentOf<typeof users>['email'], string>>(true);

const repo = createRepository(db, users);
const postRepo = createRepository(db, posts);

// Reads give documents back.
const found = await repo.findById({} as ObjectId);
assertType<Equal<typeof found, User | undefined>>(true);
const got = await repo.getById({} as ObjectId);
assertType<Equal<typeof got, User>>(true);
const many = await repo.findMany();
assertType<Equal<typeof many, User[]>>(true);

// create takes the schema's input.
await repo.create({ email: 'ada@example.com' });
// @ts-expect-error email is required
await repo.create({ name: 'Ada' });
// @ts-expect-error age is a number
await repo.create({ email: 'ada@example.com', age: 'old' });
// @ts-expect-error no such field
await repo.create({ email: 'ada@example.com', nope: 1 });

// A patch is checked against the document, unlike the driver's UpdateFilter.
await repo.update({} as ObjectId, { name: null });
// @ts-expect-error email is a string
await repo.update({} as ObjectId, { email: 1 });
// MongoDB's operators are the escape hatch.
await repo.update({} as ObjectId, { $inc: { version: 2 } });

// Filters are the driver's, typed by the document.
await repo.findMany({ filter: { email: 'a', age: { $gt: 3 } } });
// @ts-expect-error email is a string
await repo.count({ email: 1 });
await repo.exists({ deletedAt: null });

// The cursor pages along a field of the schema.
const cursorPage = await repo.paginateByCursor({ orderBy: 'createdAt' });
assertType<Equal<typeof cursorPage, CursorPage<User>>>(true);
// @ts-expect-error no such field
await repo.paginateByCursor({ orderBy: 'nope' });
const page = await repo.paginate({ pageSize: 10 });
assertType<Equal<typeof page, Page<User>>>(true);

// `with` and `as` give back the same repository.
await withTransaction(db as never, async (session) => {
	const scoped: Repository<typeof users> = repo.with(session);
	await scoped.create({ email: 'ada@example.com' });
	await repo.as({} as ObjectId).create({ email: 'b@example.com' });
});

// A collection of another shape is another repository.
const post = await postRepo.getById({} as ObjectId);
assertType<Equal<typeof post.rank, number>>(true);
// @ts-expect-error posts have no email
await postRepo.create({ email: 'a@example.com', title: 't', rank: 1 });

// A definition needs an _id, and its settings are typed.
defineCollection({
	name: 'tags',
	schema: z.object({ _id: id(), slug: z.string() }),
	indexes: [{ key: { slug: 1 }, unique: true }],
	validation: { level: 'moderate', action: 'warn' },
});
defineCollection({
	name: 'tags',
	schema: z.object({ _id: objectId(), ...timestamps(), ...softDelete() }),
	// @ts-expect-error not a validation level
	validation: { level: 'lenient' },
});

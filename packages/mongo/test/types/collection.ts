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
	ReadDocumentOf,
	TypedCollection,
} from '../../src';
import {
	defineCollection,
	getCollection,
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

const collection = getCollection(db, users);
const postRepo = getCollection(db, posts);

// Reads give documents back, each with the `id` the collection computes.
type ReadUser = ReadDocumentOf<typeof users>;
const found = await collection.findById({} as ObjectId);
assertType<Equal<typeof found, ReadUser | undefined>>(true);
const got = await collection.getById({} as ObjectId);
assertType<Equal<typeof got, ReadUser>>(true);
const many = await collection.findMany();
assertType<Equal<typeof many, ReadUser[]>>(true);
// The stored document is the schema's, `id` apart.
assertType<Equal<Omit<ReadUser, 'id'>, User>>(true);

// create takes the schema's input.
await collection.create({ email: 'ada@example.com' });
// @ts-expect-error email is required
await collection.create({ name: 'Ada' });
// @ts-expect-error age is a number
await collection.create({ email: 'ada@example.com', age: 'old' });
// @ts-expect-error no such field
await collection.create({ email: 'ada@example.com', nope: 1 });

// A patch is checked against the document, unlike the driver's UpdateFilter.
await collection.update({} as ObjectId, { name: null });
// @ts-expect-error email is a string
await collection.update({} as ObjectId, { email: 1 });
// MongoDB's operators are the escape hatch.
await collection.update({} as ObjectId, { $inc: { version: 2 } });

// Filters are the driver's, typed by the document.
await collection.findMany({ filter: { email: 'a', age: { $gt: 3 } } });
// @ts-expect-error email is a string
await collection.count({ email: 1 });
await collection.exists({ deletedAt: null });

// The cursor pages along a field of the schema.
const cursorPage = await collection.paginateByCursor({ orderBy: 'createdAt' });
assertType<Equal<typeof cursorPage, CursorPage<ReadUser>>>(true);
// @ts-expect-error no such field
await collection.paginateByCursor({ orderBy: 'nope' });
const page = await collection.paginate({ pageSize: 10 });
assertType<Equal<typeof page, Page<ReadUser>>>(true);

// `with` and `as` give back the same collection.
await withTransaction(db as never, async (session) => {
	const scoped: TypedCollection<typeof users> = collection.withSession(session);
	await scoped.create({ email: 'ada@example.com' });
	await collection.as({} as ObjectId).create({ email: 'b@example.com' });
});

// A collection of another shape is another collection.
const post = await postRepo.getById({} as ObjectId);
assertType<Equal<typeof post.rank, number>>(true);
// @ts-expect-error posts have no email
await postRepo.create({ email: 'a@example.com', title: 't', rank: 1 });

// A read gives back the document plus `id`, the string of `_id`.
assertType<Equal<typeof got.id, string>>(true);
assertType<Equal<(typeof many)[number]['id'], string>>(true);
assertType<Equal<(typeof page.items)[number]['id'], string>>(true);
const created = await collection.create({ email: 'ada@example.com' });
assertType<Equal<typeof created.id, string>>(true);
// It is computed, not stored: a write does not take it.
// @ts-expect-error id is not a field of the document
await collection.create({ email: 'ada@example.com', id: 'abc' });
// @ts-expect-error id is not a field of the document
await collection.update({} as ObjectId, { id: 'abc' });

// A definition needs an _id, and its settings are typed.
defineCollection({
	name: 'tags',
	schema: z.object({ _id: id(), slug: z.string() }),
	indexes: [{ key: { slug: 1 }, unique: true }],
	validation: { level: 'moderate', action: 'warn' },
});

// An index is keyed on the schema's fields, which is what an editor completes.
defineCollection({
	name: 'users',
	schema: users.schema,
	indexes: [
		{ key: { email: 1 }, unique: true, name: 'users_email_unique' },
		{ key: { createdAt: -1, email: 1 } },
		// A path into a field: MongoDB indexes nested keys this way.
		{ key: { 'teamId.slug': 1 } },
		{ key: { email: 'text' }, collation: { locale: 'fr' } },
	],
});
defineCollection({
	name: 'users',
	schema: users.schema,
	// @ts-expect-error no such field to index
	indexes: [{ key: { emial: 1 } }],
});
defineCollection({
	name: 'users',
	schema: users.schema,
	// @ts-expect-error 'up' is not an index direction
	indexes: [{ key: { email: 'up' } }],
});
defineCollection({
	name: 'tags',
	schema: z.object({ _id: objectId(), ...timestamps(), ...softDelete() }),
	// @ts-expect-error not a validation level
	validation: { level: 'lenient' },
});

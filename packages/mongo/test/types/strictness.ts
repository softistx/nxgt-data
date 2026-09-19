// What the collection refuses to compile. Each `@ts-expect-error` is a
// mistake that must not get past the compiler: if one ever does compile, tsc
// reports the directive as unused and this file fails the typecheck.
//
// It is the measure of the package's type safety, kept as a test rather than
// as a claim in a README.

import type { Db, ObjectId } from 'mongodb';
import { getCollection } from '../../src';
import { posts, users } from '../schema';

declare const db: Db;
const collection = getCollection(db, users);
const postCollection = getCollection(db, posts);
const id = {} as ObjectId;

// --- sort ---------------------------------------------------------------
await collection.findMany({ sort: { email: 1, createdAt: -1 } });
await collection.findMany({ sort: { 'teamId.slug': 'asc' } });
// @ts-expect-error no such field to sort on
await collection.findMany({ sort: { nope: 1 } });
// @ts-expect-error 'up' is not a direction
await collection.findMany({ sort: { email: 'up' } });
// @ts-expect-error paginate sorts on the schema's fields too
await collection.paginate({ sort: { nope: 1 } });

// --- projection ---------------------------------------------------------
await collection.findMany({ projection: { email: 1, _id: 0 } });
await postCollection.findMany({ projection: { tags: { $slice: 3 } } });
// @ts-expect-error no such field to project
await collection.findMany({ projection: { nope: 1 } });
// @ts-expect-error a projection is 0, 1 or an operator
await collection.findMany({ projection: { email: 2 } });

// --- patches ------------------------------------------------------------
await collection.update(id, { name: 'Ada' });
await collection.update(id, { $set: { name: 'Ada' } });
await collection.update(id, { $inc: { age: 1 } });
await postCollection.update(id, { $push: { tags: 'new' } });
await postCollection.update(id, { $push: { tags: { $each: ['a', 'b'] } } });
// @ts-expect-error no such field on the document
await collection.update(id, { nope: 1 });
// @ts-expect-error no such field to $set
await collection.update(id, { $set: { nope: 1 } });
// @ts-expect-error email is a string, not a number
await collection.update(id, { $set: { email: 1 } });
// @ts-expect-error $inc wants a numeric field, and email is a string
await collection.update(id, { $inc: { email: 1 } });
// @ts-expect-error tags holds strings
await postCollection.update(id, { $push: { tags: 42 } });
// @ts-expect-error name is not an array
await postCollection.update(id, { $push: { title: 'x' } });
// @ts-expect-error id is computed, never written
await collection.update(id, { id: 'abc' });

// --- the actor ----------------------------------------------------------
collection.as(id);
// @ts-expect-error the actor is an ObjectId, as the schema declares it
collection.as('not-an-object-id');
// @ts-expect-error posts have no createdBy, so they have no actor to stamp
postCollection.as(id);

// --- what is not checked, on purpose ------------------------------------
// The tail of a dotted path cannot be checked against a schema, so a filter
// on a path into a field that exists is accepted whatever is under it. The
// head is checked wherever this package owns the type (sort, projection,
// $set); a filter is the driver's `Filter`, which is looser.
await collection.findMany({ filter: { 'teamId.whatever': 1 } });

// --- the driver's own methods, on the same object -----------------------
collection.aggregate([{ $match: { email: 'a@b.co' } }]);
collection.watch();
await collection.distinct('email');
await collection.estimatedDocumentCount();
await collection.raw.updateMany({}, { $set: { name: 'x' } });
await collection.raw.count();

// --- the three names this package redefines -----------------------------
const changed: number = await collection.updateMany(
	{ name: null },
	{ name: 'x' },
);
const removed: number = await collection.deleteMany({ name: null });
const counted: number = await collection.count();
void changed;
void removed;
void counted;

// --- what coercion widens, and what it does not -------------------------
// The collection reads a string on an `ObjectId` or a `Date` field, so the
// types take one there — and nowhere else.
await collection.findById('68ca1f0f2b1c4d5e6f7a8b90');
await collection.findMany({ filter: { teamId: '68ca1f0f2b1c4d5e6f7a8b90' } });
await collection.findMany({
	filter: { teamId: { $in: ['68ca1f0f2b1c4d5e6f7a8b90'] } },
});
await collection.findMany({ filter: { createdAt: { $gte: '2026-01-01' } } });
await collection.create({
	email: 'a@example.com',
	teamId: '68ca1f0f2b1c4d5e6f7a8b90',
});
await collection.update('68ca1f0f2b1c4d5e6f7a8b90', {
	teamId: '68ca1f0f2b1c4d5e6f7a8b90',
});
await collection.update(id, { $set: { teamId: '68ca1f0f2b1c4d5e6f7a8b90' } });
// @ts-expect-error a number is not an id, and never becomes one
await collection.findById(42);
// @ts-expect-error nor in a filter
await collection.findMany({ filter: { teamId: 42 } });
// @ts-expect-error nor is a number a date: '1' would be 1970
await collection.findMany({ filter: { createdAt: { $gte: 1 } } });
// @ts-expect-error email is a string field, so it is widened by nothing
await collection.findMany({ filter: { email: id } });
// @ts-expect-error and a string field still refuses a number
await collection.create({ email: 42 });

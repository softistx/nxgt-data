// What a write may say about the stamps, checked by `tsc` and never run.
// The collection keeps them: `createdAt` and `updatedAt` may be given on
// create, `updatedAt` on update, and the version only as the one expected.

import type { Db, ObjectId } from 'mongodb';
import { getCollection, type NewDocumentOf } from '../../src';
import { tickets, users } from '../schema';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const db: Db;
declare const id: ObjectId;
const people = getCollection(db, users);
const desk = getCollection(db, tickets);
const at = new Date();

// --- create -------------------------------------------------------------
assertType<Equal<NewDocumentOf<typeof users>['createdAt'], Date | undefined>>(
	true,
);
assertType<Equal<NewDocumentOf<typeof users>['updatedAt'], Date | undefined>>(
	true,
);
await people.create({ email: 'a@example.com' });
// A document imported with its own dates keeps them.
await people.create({ email: 'a@example.com', createdAt: at, updatedAt: at });
// A timestamp may also be given as the string it arrived as: the collection
// reads it, because the schema says the field is a date.
await people.create({ email: 'a@example.com', createdAt: '2024-01-01' });
// @ts-expect-error and a number is not a date, in the types as at runtime
await people.create({ email: 'a@example.com', createdAt: 1 });
// @ts-expect-error the version starts where the collection says
await people.create({ email: 'a@example.com', version: 1 });
// @ts-expect-error a new document is not deleted
await people.create({ email: 'a@example.com', deletedAt: null });
// @ts-expect-error the actors come from `as(actor)`
await people.create({ email: 'a@example.com', createdBy: null });
// @ts-expect-error …all of them
await people.create({ email: 'a@example.com', updatedBy: null });
// @ts-expect-error …all of them
await people.create({ email: 'a@example.com', deletedBy: null });
// @ts-expect-error a many-create is refused the same way
await people.createMany([{ email: 'a@example.com', version: 0 }]);
// Under the names the collection gives them.
await desk.create({ subject: 'x', createdAt: at });
// @ts-expect-error `revision` is the version here
await desk.create({ subject: 'x', revision: 0 });
// @ts-expect-error `removedAt` is the soft-delete field here
await desk.create({ subject: 'x', removedAt: null });
// @ts-expect-error `openedBy` is the creating actor here
await desk.create({ subject: 'x', openedBy: null });

// A document that was read is not a create as it is: its stamps are kept.
declare const read: Awaited<ReturnType<typeof people.getById>>;
// @ts-expect-error it carries a version, a deletedAt and its actors
await people.create(read);

// --- update -------------------------------------------------------------
await people.update(id, { name: 'Ada' });
await people.update(id, { name: 'Ada', updatedAt: at });
// The version, under its own name, is the one the document must be at.
await people.update(id, { name: 'Ada', version: 3 });
await people.update(id, { $set: { name: 'Ada' }, version: 3 });
await people.update(id, { $currentDate: { updatedAt: true } });
// @ts-expect-error createdAt never moves
await people.update(id, { createdAt: at });
// @ts-expect-error the soft delete is `delete` and `restore`
await people.update(id, { deletedAt: at });
// @ts-expect-error the actors come from `as(actor)`
await people.update(id, { updatedBy: null });
// @ts-expect-error …all of them
await people.update(id, { createdBy: null });
// @ts-expect-error …all of them
await people.update(id, { deletedBy: null });
// @ts-expect-error an expected version is a number
await people.update(id, { name: 'Ada', version: '3' });
// @ts-expect-error nor through an operator
await people.update(id, { $set: { version: 9 } });
// @ts-expect-error …any operator
await people.update(id, { $inc: { version: 1 } });
// @ts-expect-error …any stamp
await people.update(id, { $set: { createdAt: at } });
// @ts-expect-error …any stamp
await people.update(id, { $unset: { deletedAt: '' } });
// @ts-expect-error …any stamp
await people.update(id, { $currentDate: { createdAt: true } });
// @ts-expect-error …nor by renaming a field onto it
await people.update(id, { $rename: { name: 'deletedAt' } });
// @ts-expect-error …nor by renaming it away
await people.update(id, { $rename: { createdAt: 'name' } });
// @ts-expect-error …nor under a path, whatever the operator
await people.update(id, { $push: { 'deletedAt.x': 1 } });
// @ts-expect-error …any of them
await people.update(id, { $addToSet: { 'createdBy.x': 1 } });
// @ts-expect-error updatedAt may be set, not taken away
await people.update(id, { $unset: { updatedAt: '' } });
// @ts-expect-error …nor renamed away
await people.update(id, { $rename: { updatedAt: 'name' } });
await people.update(id, { $unset: { age: '' } });
await people.update(id, { $rename: { name: 'age' } });
await desk.update(id, { subject: 'y', revision: 2 });
// @ts-expect-error `revision` is the version here
await desk.update(id, { subject: 'y', version: 2 });
// @ts-expect-error `removedAt` is the soft-delete field here
await desk.update(id, { removedAt: at });
// @ts-expect-error the expected version is in the patch, not an option
await people.update(id, { name: 'Ada' }, { expectedVersion: 3 });

// --- updateMany ---------------------------------------------------------
await people.updateMany({ name: null }, { name: 'x', updatedAt: at });
// @ts-expect-error one version cannot stand for many documents
await people.updateMany({ name: null }, { name: 'x', version: 1 });
// @ts-expect-error createdAt never moves
await people.updateMany({ name: null }, { createdAt: at });

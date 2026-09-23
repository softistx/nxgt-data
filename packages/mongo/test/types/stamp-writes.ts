// What a write may say about the stamps, checked by `tsc` and never run.
// The collection keeps them: `createdAt` and `updatedAt` may be given on
// create, `updatedAt` on update, and the version only as the one expected.

import type { Db, ObjectId } from 'mongodb';
import { getCollection, type NewDocumentOf } from '../../src';
import { type Post, posts, tickets, users } from '../schema';

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

// --- _id ----------------------------------------------------------------
// MongoDB never changes an `_id`, and no update-shaped call of this package
// writes one: `update`, `updateMany` and `upsert` refuse it in the types, in
// every operator, and at run time. `delete`, `hardDelete` and `restore` take
// no patch. The driver's own `updateOne` and `raw` are not this package's.
declare const post: Post;
const board = getCollection(db, posts);
await board.update(id, { title: 'y' });
// @ts-expect-error no update writes `_id`
await people.update(id, { _id: id });
// @ts-expect-error …as the string it arrived as either
await people.update(id, { _id: '507f1f77bcf86cd799439011' });
// @ts-expect-error …beside an expected version
await people.update(id, { _id: id, name: 'Ada', version: 3 });
// @ts-expect-error …on a collection with no stamps at all
await board.update(id, { _id: id, title: 'y' });
// @ts-expect-error …where a whole document used to fit
await board.update(id, post);
// @ts-expect-error …through `$set`
await people.update(id, { $set: { _id: id } });
// @ts-expect-error …through `$setOnInsert`
await people.update(id, { $setOnInsert: { _id: id } });
// @ts-expect-error …through `$unset`
await people.update(id, { $unset: { _id: '' } });
// @ts-expect-error …by renaming it away
await people.update(id, { $rename: { _id: 'name' } });
// @ts-expect-error …or a field onto it
await people.update(id, { $rename: { name: '_id' } });
// @ts-expect-error …through `$min`
await people.update(id, { $min: { _id: id } });
// @ts-expect-error …through `$max`
await people.update(id, { $max: { _id: id } });
// @ts-expect-error …through `$currentDate`
await people.update(id, { $currentDate: { _id: true } });
// @ts-expect-error …nor under a path
await people.update(id, { $set: { '_id.x': 1 } });
// @ts-expect-error …whatever the operator
await people.update(id, { $inc: { '_id.x': 1 } });
// @ts-expect-error …on a collection acting for someone
await people.as(id).update(id, { _id: id });
// @ts-expect-error …or bound to a session
await people.withSession(undefined).update(id, { _id: id });
// @ts-expect-error `updateMany` refuses it the same way
await people.updateMany({ name: null }, { _id: id });
// @ts-expect-error …through an operator too
await people.updateMany({ name: null }, { $set: { _id: id } });
// @ts-expect-error an upsert's values are written on both halves
await board.upsert({ title: 'a' }, { _id: id, rank: 1 });
// The filter is where an upsert names the `_id` an insert gets.
await board.upsert({ _id: id }, { title: 'a', rank: 1 });
// A document that was read is written back without its `_id`.
const { _id, ...fields } = post;
await board.update(id, fields);
// The driver's own `updateOne` is the driver's: this package types nothing
// of its own there.
await people.updateOne({ _id: id }, { $set: { name: 'Ada' } });

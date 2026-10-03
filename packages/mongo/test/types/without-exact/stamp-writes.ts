// What `_id` does under a consumer's tsconfig without
// `exactOptionalPropertyTypes`, checked by `tsc` and never run.

import type { Db, ObjectId } from 'mongodb';
import { getCollection } from '../../../src';
import { posts, users } from '../../schema';

declare const db: Db;
declare const id: ObjectId;
const people = getCollection(db, users);
const board = getCollection(db, posts);

// The one gap, pinned: a top-level `_id: undefined` COMPILES, because
// `_id?: never` accepts `undefined` without `exactOptionalPropertyTypes`
// (which most consumers leave off; this repository turns it on, so
// `../stamp-writes.ts` holds the refusal). The run time refuses it —
// `id.spec.ts`, "as undefined" and the upsert spec. If this ever stops
// compiling, the docs that name the gap are out of date.
await people.update(id, { _id: undefined, name: 'Ada' });
await people.updateMany({ name: null }, { _id: undefined, name: 'x' });
await board.upsert({ title: 'a' }, { _id: undefined, rank: 1 });
declare const body: { name: string };
await people.update(id, { ...body, _id: undefined });
// Inside an operator it does not compile.
// @ts-expect-error `$set: { _id: undefined }` is refused by the types
await people.update(id, { $set: { name: 'Ada', _id: undefined } });

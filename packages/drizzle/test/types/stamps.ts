// Type tests for the optimistic lock, the actor stamps and upsert, checked by
// `tsc --noEmit` and never run. Each `@ts-expect-error` is a call that must
// not compile: if it compiles, tsc reports the unused directive.

import { sql } from 'drizzle-orm';
import {
	bigint,
	doublePrecision,
	integer,
	pgTable,
	text,
} from 'drizzle-orm/pg-core';
import {
	type ActorOf,
	createRepository,
	type LockOf,
	type Repository,
	type Row,
} from '../../src/pg';
import { createTestDb } from '../db';
import { posts, teams, tickets, users } from '../schema';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

const { db } = await createTestDb();
const ticketRepo = createRepository(db, tickets);
const userRepo = createRepository(db, users);
const teamRepo = createRepository(db, teams);

// A table locks by default when it has an integer NOT NULL `version`.
assertType<Equal<LockOf<typeof tickets>, true>>(true);
assertType<Equal<LockOf<typeof users>, false>>(true);
// A `version` that is a number but not a counter does not lock, at run time
// or in the types: a `double` version is written, never checked.
const measured = pgTable('measured', {
	id: integer('id').primaryKey(),
	version: doublePrecision('version').notNull(),
});
assertType<Equal<LockOf<typeof measured>, false>>(true);
const drafts = pgTable('drafts', {
	id: integer('id').primaryKey(),
	version: integer('version'),
	title: text('title'),
});
assertType<Equal<LockOf<typeof drafts>, false>>(true);
const counted = pgTable('counted', {
	id: integer('id').primaryKey(),
	version: bigint('version', { mode: 'bigint' }).notNull(),
});
assertType<Equal<LockOf<typeof counted>, false>>(true);
// @ts-expect-error a double version is no counter
createRepository(db, measured, { optimisticLock: true });
// @ts-expect-error a nullable version checks nothing
createRepository(db, drafts, { optimisticLock: true });
// @ts-expect-error a bigint-mode version is not read back as a number
createRepository(db, counted, { optimisticLock: true });
// @ts-expect-error users has no version to lock on
createRepository(db, users, { optimisticLock: true });
createRepository(db, users, { optimisticLock: false });

// update takes the version it read — a number, never SQL.
await ticketRepo.update('x', { title: 'b', version: 3 });
// @ts-expect-error the expected version is a number
await ticketRepo.update('x', { title: 'b', version: '3' });
// @ts-expect-error the expected version is a condition, not SQL to write
await ticketRepo.update('x', { version: sql`${tickets.version} + 1` });
// updateMany takes none: one version cannot stand for many rows.
await ticketRepo.updateMany({ slug: 'a' }, { title: 'b' });
// @ts-expect-error updateMany refuses a version
await ticketRepo.updateMany({ slug: 'a' }, { version: 3 });

// With the lock off, `version` is an ordinary column again.
const unlocked = createRepository(db, tickets, { optimisticLock: false });
await unlocked.updateMany({ slug: 'a' }, { version: sql`0` });
await unlocked.updateMany({ slug: 'a' }, { version: 3 });
await unlocked.upsert({ slug: 'a' }, { title: 'A', version: 3 });
assertType<
	Equal<typeof unlocked, Repository<typeof tickets, 'id', true, false>>
>(true);

// The actor is typed by the actor columns.
assertType<Equal<ActorOf<typeof tickets>, string>>(true);
const acting = ticketRepo.as('b1c7…');
assertType<Equal<typeof acting, typeof ticketRepo>>(true);
// @ts-expect-error the actor columns are uuids
ticketRepo.as(1);
// @ts-expect-error nobody is not an actor: use the repository without as()
ticketRepo.as(null);
// @ts-expect-error teams has no actor column to stamp
teamRepo.as('someone');
createRepository(db, tickets, { actor: 'b1c7…' });
// @ts-expect-error the actor columns are uuids
createRepository(db, tickets, { actor: 1 });
// @ts-expect-error nobody is not an actor: leave the option out
createRepository(db, tickets, { actor: null });
// @ts-expect-error users has no actor column either
createRepository(db, users, { actor: 'b1c7…' });

// upsert: the where names the key, the values the rest.
const upserted = await ticketRepo.upsert({ slug: 'a' }, { title: 'A' });
assertType<Equal<typeof upserted, Row<typeof tickets>>>(true);
await userRepo.upsert({ email: 'a@example.com' }, {});
await userRepo.upsert({ email: 'a@example.com' }, { name: sql`'x'` });
// @ts-expect-error title is required: the insert half needs it
await ticketRepo.upsert({ slug: 'a' }, {});
// @ts-expect-error the where names the key; the values do not repeat it
await ticketRepo.upsert({ slug: 'a' }, { slug: 'b', title: 'A' });
// @ts-expect-error a key in the where is a value, never null
await userRepo.upsert({ name: null }, { email: 'a@example.com' });
// @ts-expect-error a key in the where is a value, never SQL
await userRepo.upsert({ email: sql`'a'` }, {});
// @ts-expect-error no such column
await userRepo.upsert({ emial: 'a@example.com' }, {});
// @ts-expect-error the repository keeps the version
await ticketRepo.upsert({ slug: 'a' }, { title: 'A', version: 1 });
// @ts-expect-error the version is no key to conflict on
await ticketRepo.upsert({ slug: 'a', version: 1 }, { title: 'A' });
// @ts-expect-error an empty where has nothing to conflict on
await userRepo.upsert({}, { email: 'a@example.com' });
// @ts-expect-error email is a string
await userRepo.upsert({ email: 1 }, {});

// A table without the lock takes `version`-free patches as before.
await createRepository(db, posts).update(1, { title: 'b' });

// Type tests for the optimistic lock and the actor stamps, checked by
// `tsc --noEmit` and never run. Each `@ts-expect-error` is a call that must
// not compile: if it compiles, tsc reports the unused directive.

import { sql } from 'drizzle-orm';
import {
	type ActorOf,
	createRepository,
	type LockOf,
	type Repository,
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
const teamRepo = createRepository(db, teams);

// A table locks by default when it has an integer NOT NULL `version`.
assertType<Equal<LockOf<typeof tickets>, true>>(true);
assertType<Equal<LockOf<typeof users>, false>>(true);

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
assertType<
	Equal<typeof unlocked, Repository<typeof tickets, 'id', true, false>>
>(true);

// The actor is typed by the actor columns.
assertType<Equal<ActorOf<typeof tickets>, string>>(true);
const acting = ticketRepo.as('b1c7…');
assertType<Equal<typeof acting, typeof ticketRepo>>(true);
// @ts-expect-error the actor columns are uuids
ticketRepo.as(1);
// @ts-expect-error teams has no actor column to stamp
teamRepo.as('someone');
createRepository(db, tickets, { actor: 'b1c7…' });
// @ts-expect-error users has no actor column either
createRepository(db, users, { actor: 'b1c7…' });

// A table without the lock takes `version`-free patches as before.
await createRepository(db, posts).update(1, { title: 'b' });

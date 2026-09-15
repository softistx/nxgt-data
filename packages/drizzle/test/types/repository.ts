// Type tests, checked by `tsc --noEmit` and never run. Each `@ts-expect-error`
// is a call that must not compile: if it compiles, tsc reports the unused
// directive.

import { eq } from 'drizzle-orm';
import type { CursorPage, Page } from '../../src';
import {
	createRepository,
	paginate,
	type Repository,
	type Row,
	withTransaction,
} from '../../src/pg';
import { createTestDb } from '../db';
import { logs, memberships, posts, teams, users } from '../schema';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

const { db } = await createTestDb();

// The id's type is the primary key's.
const userRepo = createRepository(db, users);
const teamRepo = createRepository(db, teams);
await userRepo.findById('b1c7…');
// @ts-expect-error users.id is a uuid string
await userRepo.findById(1);
await teamRepo.getById(1);
// @ts-expect-error teams.id is an integer
await teamRepo.getById('1');

// Rows are the table's select model.
const user = await userRepo.getById('x');
assertType<Equal<typeof user, typeof users.$inferSelect>>(true);
assertType<Equal<typeof user.createdAt, Date>>(true);
assertType<Equal<typeof user.deletedAt, Date | null>>(true);
const maybe = await userRepo.findById('x');
assertType<Equal<typeof maybe, Row<typeof users> | undefined>>(true);
const many = await userRepo.findMany();
assertType<Equal<typeof many, (typeof users.$inferSelect)[]>>(true);

// create takes the insert model.
await userRepo.create({ email: 'a@example.com' });
// @ts-expect-error email is required
await userRepo.create({ name: 'Ada' });
// @ts-expect-error age is a number
await userRepo.create({ email: 'a@example.com', age: 'old' });
// @ts-expect-error no such column
await userRepo.create({ email: 'a@example.com', nope: 1 });

// update takes a partial patch.
await userRepo.update('x', { name: null });
// @ts-expect-error email is not nullable
await userRepo.update('x', { email: null });

// where objects are typed by column.
await userRepo.findMany({ where: { email: 'a', name: null } });
// @ts-expect-error email is a string
await userRepo.findMany({ where: { email: 1 } });
// @ts-expect-error no such column
await userRepo.count({ nope: 1 });
await userRepo.findMany({
	where: eq(users.age, 3),
	orderBy: { createdAt: 'desc' },
});
// @ts-expect-error not a direction
await userRepo.findMany({ orderBy: { createdAt: 'down' } });

// Soft-delete methods exist only on a table with deletedAt.
await userRepo.restore('x');
await userRepo.hardDelete('x');
// @ts-expect-error teams has no deletedAt
await teamRepo.restore(1);
const noSoft = createRepository(db, users, { softDelete: false });
// @ts-expect-error soft delete is off
await noSoft.restore('x');

// A composite or missing primary key leaves the methods by id uncallable…
const members = createRepository(db, memberships);
// @ts-expect-error memberships has a composite primary key
await members.findById('x');
// @ts-expect-error logs has no primary key
await createRepository(db, logs).delete('x');
// …unless primaryKey names a column.
const byRole = createRepository(db, memberships, { primaryKey: 'role' });
await byRole.findById('owner');
// @ts-expect-error no such column
createRepository(db, memberships, { primaryKey: 'nope' });

// The cursor orders by a column key.
const cursorPage = await teamRepo.paginateByCursor({ orderBy: 'name' });
assertType<Equal<typeof cursorPage, CursorPage<typeof teams.$inferSelect>>>(
	true,
);
// @ts-expect-error no such column
await teamRepo.paginateByCursor({ orderBy: 'nope' });

// A transaction is a database, typed by the driver.
await withTransaction(db, async (tx) => {
	const scoped: Repository<typeof users> = userRepo.with(tx);
	await scoped.create({ email: 'a@example.com' });
	await createRepository(tx, posts).create({ title: 't', rank: 1 });
	// @ts-expect-error a transaction has no $client
	tx.$client;
});

// paginate infers the row from the select.
const joined = await paginate(
	db,
	db
		.select({ email: users.email, team: teams.name })
		.from(users)
		.innerJoin(teams, eq(users.teamId, teams.id)),
	{ page: 1 },
);
assertType<Equal<typeof joined, Page<{ email: string; team: string }>>>(true);
// @ts-expect-error a query that already has a limit cannot be paged
await paginate(db, db.select().from(users).limit(1));

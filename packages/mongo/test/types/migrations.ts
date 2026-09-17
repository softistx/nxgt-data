// What `@nxgt/mongo/migrations` accepts, checked by `tsc` and never run.

import type { ClientSession, Db, MongoClient } from 'mongodb';
import {
	defineMigration,
	type MigrationContext,
	type MigrationStatus,
	migrate,
	migrationStatus,
	rollback,
} from '../../src/migrations';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const db: Db;
declare const client: MongoClient;

assertType<Equal<MigrationContext['session'], ClientSession | undefined>>(true);
assertType<Equal<MigrationContext['client'], MongoClient>>(true);

const one = defineMigration({
	id: 'one',
	async up({ db, session }) {
		await db
			.collection('posts')
			.updateMany({}, { $set: { x: 1 } }, { session });
	},
	async down() {},
	transaction: false,
});

// @ts-expect-error a migration has an id
defineMigration({ up: async () => {} });
// @ts-expect-error …and it is a string
defineMigration({ id: 1, up: async () => {} });
// @ts-expect-error a migration has an up
defineMigration({ id: 'x' });
// @ts-expect-error up is awaited
defineMigration({ id: 'x', up: () => {} });
// @ts-expect-error down is a step too
defineMigration({ id: 'x', up: async () => {}, down: 'undo' });
// @ts-expect-error transaction is on or off
defineMigration({ id: 'x', up: async () => {}, transaction: 'yes' });
// @ts-expect-error there is no such option
defineMigration({ id: 'x', up: async () => {}, order: 1 });

await migrate(db, [one]);
await migrate(db, [one], { to: 'one', dryRun: true, lockTtlMs: 5000 });
await rollback(db, [one], { to: 'one', collection: 'history' });
const status: MigrationStatus[] = await migrationStatus(db, [one]);
assertType<Equal<MigrationStatus['state'], 'applied' | 'pending' | 'missing'>>(
	true,
);
void status;

// @ts-expect-error a database, not a client
await migrate(client, [one]);
// @ts-expect-error migrations, not their configs
await migrate(db, [{ id: 'raw', up: async () => {} }]);
// @ts-expect-error `to` names a migration by its id
await migrate(db, [one], { to: one });
// @ts-expect-error there is no such option
await migrate(db, [one], { force: true });
// @ts-expect-error a rollback has no `steps`
await rollback(db, [one], { steps: 2 });

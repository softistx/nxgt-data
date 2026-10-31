// What the Mongo refuses. Checked by `tsc --noEmit`, never run: a refusal that
// stops holding fails the typecheck on its unused directive.

import type { Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import {
	type DbMemberName,
	defineMongo,
	type MongoOf,
	openMongo,
} from '../../src';
import { defineCollection } from '../../src/definition/define-collection';
import { id, objectId } from '../../src/definition/fields';
import { collections, events, posts, users } from '../wiring';

const uri = 'mongodb://127.0.0.1:1/unused';

// Every member of the driver's Db is reserved: a release that adds one makes
// this line fail, which is the point.
type Missed = Exclude<keyof Db, DbMemberName>;
const nothingMissed: Missed[] = [];
void nothingMissed;

const config = defineMongo({ uri, collections });
const mongo = await openMongo(config);

// The scope is the collections, typed, over the driver's Db.
const one = await mongo.db.users.create({ email: 'ada@example.com' });
const email: string = one.email;
const created: Date = one.createdAt;
const name: string | undefined = one.name;
void email;
void created;
void name;
void mongo.db.command({ ping: 1 });
const dbName: string = mongo.db.databaseName;
void dbName;

// @ts-expect-error — no collection is wired under that key.
void mongo.db.usrs;

// @ts-expect-error — `emial` is no field of a user.
void mongo.db.users.create({ emial: 'ada@example.com' });

// @ts-expect-error — `email` is a string.
void mongo.db.users.create({ email: 42 });

// The actor is the one the definitions agree on.
const actor: ObjectId = null as never;
void mongo.as(actor);

// @ts-expect-error — a string is no ObjectId.
void mongo.as('ada');

// `ping` reports under the database names, and nothing else.
void mongo.ping({ timeoutMS: 500 }).then((health) => {
	const ok: boolean = health.default.ok;
	void ok;
	// @ts-expect-error — this Mongo has no database "main".
	void health.main;
});
// @ts-expect-error — the option is spelt `timeoutMS`, as the driver spells it.
void mongo.ping({ timeoutMs: 500 });

// A config's shape decides what `MongoOf` gives back.
type Opened = MongoOf<typeof config>;
const same: Opened = mongo;
void same;

// A key the driver's Db already answers to is refused where it is written.
void defineMongo({
	uri,
	// @ts-expect-error — "command" is a member of the driver's Db.
	collections: { command: users },
});

// …whichever shape the config was written in.
void defineMongo({
	databases: {
		// @ts-expect-error — "watch" is a member of the driver's Db.
		main: { uri, collections: { watch: users } },
	},
});

// @ts-expect-error — `posts` is not wired here.
void defineMongo({ uri, collections: { users }, optionsFor: { posts: {} } });

// @ts-expect-error — the wiring decides the session itself.
void defineMongo({ uri, collections, options: { session: undefined } });

// @ts-expect-error — and the database it is on.
void defineMongo({ uri, collections, options: { db: undefined } });

// @ts-expect-error — and who writes, which `as` says.
void defineMongo({ uri, collections, options: { actor: undefined } });

// @ts-expect-error — and whether to sync, which the database's `autoSync` says.
void defineMongo({ uri, collections, options: { autoSync: true } });

// With several databases there is no `db` to read: each one is named.
const many = await openMongo(
	defineMongo({
		databases: {
			main: { uri, collections },
			analytics: { uri, collections: { events } },
		},
	}),
);
void many.databases.main.users;
void many.databases.analytics.events;

// @ts-expect-error — `mongo.db` is `never` once the Mongo holds several.
void many.db.users;

// @ts-expect-error — the Mongo has no database under that name.
void many.databases.nowhere;

// @ts-expect-error — nor a client under it.
void many.clients.nowhere;

// @ts-expect-error — a transaction runs on a database the Mongo has.
void many.transaction(async () => undefined, { on: 'nowhere' });

void many.transaction(
	async (tx) => {
		void tx.databases.main.users;
	},
	{ on: 'main' },
);

// `database` derives a Mongo on another database of the same client. With
// several, `from` says whose collections, and is required.
// @ts-expect-error — no options: which database's collections?
void many.database('t');
// @ts-expect-error — empty options say nothing either.
void many.database('t', {});
// @ts-expect-error — the Mongo has no database under that name.
void many.database('t', { from: 'nope' });
const tenantOfAnalytics = many.database('t', { from: 'analytics' });
void tenantOfAnalytics.db.events;
// @ts-expect-error — the analytics database wires no `users`.
void tenantOfAnalytics.db.users;
void many.database('t', {
	from: 'main',
	options: { validate: 'off' },
	optionsFor: { users: { coerce: true } },
});
// @ts-expect-error — `optionsFor` under a key the source does not wire.
void many.database('t', { from: 'main', optionsFor: { events: {} } });
// @ts-expect-error — the wiring decides `autoSync`.
void many.database('t', { from: 'main', options: { autoSync: true } });

// With one, there is nothing to choose.
const tenant = mongo.database('t');
void tenant.db.users;
void mongo.database('t', { from: undefined });
// @ts-expect-error — `events` is not wired by this Mongo.
void tenant.db.events;

// Collections whose actors disagree leave nothing to stamp.
const counters = defineCollection({
	name: 'counters',
	schema: z.object({ _id: id(), n: z.number() }),
	actors: { type: z.string() },
});
const mixed = await openMongo(
	defineMongo({ uri, collections: { posts, counters } }),
);

// @ts-expect-error — an ObjectId and a string agree on nothing.
void mixed.as(actor);

// A collection with no actor at all asks for none.
const quiet = await openMongo(defineMongo({ uri, collections: { events } }));

// @ts-expect-error — nothing to stamp, so `as` takes nothing.
void quiet.as(objectId());

void many.transaction(async () => undefined, {
	on: 'main',
	retryTransient: false,
});

void many.transaction(async () => undefined, {
	on: 'main',
	// @ts-expect-error — `retryTransient` is a boolean.
	retryTransient: 'no',
});

// The transaction default is a boolean, and nothing else is a key of it.
void defineMongo({
	uri,
	collections,
	transactions: { retryTransient: false },
});

void defineMongo({
	uri,
	collections,
	// @ts-expect-error — `retryTransient` is a boolean.
	transactions: { retryTransient: 'no' },
});

void defineMongo({
	uri,
	collections,
	// @ts-expect-error — `transactions` takes `retryTransient` and nothing else.
	transactions: { retries: 3 },
});

void defineMongo({
	databases: {
		a: {
			uri,
			collections,
			// @ts-expect-error — `transactions` belongs beside `databases`, not in one.
			transactions: { retryTransient: false },
		},
	},
});

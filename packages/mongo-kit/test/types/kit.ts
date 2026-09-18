// What the kit refuses. Checked by `tsc --noEmit`, never run: a refusal that
// stops holding fails the typecheck on its unused directive.
import { defineCollection, id, objectId } from '@nxgt/mongo';
import type { Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import {
	createKit,
	defineConfig,
	type KitOf,
	type ReservedName,
} from '../../src';
import { collections, events, posts, users } from '../fixtures';

const uri = 'mongodb://127.0.0.1:1/unused';

// Every member of the driver's Db is reserved: a release that adds one makes
// this line fail, which is the point.
type Missed = Exclude<keyof Db, ReservedName>;
const nothingMissed: Missed[] = [];
void nothingMissed;

const config = defineConfig({ uri, collections });
const kit = await createKit(config);

// The scope is the collections, typed, over the driver's Db.
const one = await kit.db.users.create({ email: 'ada@example.com' });
const email: string = one.email;
const created: Date = one.createdAt;
const name: string | undefined = one.name;
void email;
void created;
void name;
void kit.db.command({ ping: 1 });
const dbName: string = kit.db.databaseName;
void dbName;

// @ts-expect-error — no collection is wired under that key.
void kit.db.usrs;

// @ts-expect-error — `emial` is no field of a user.
void kit.db.users.create({ emial: 'ada@example.com' });

// @ts-expect-error — `email` is a string.
void kit.db.users.create({ email: 42 });

// The actor is the one the definitions agree on.
const actor: ObjectId = null as never;
void kit.as(actor);

// @ts-expect-error — a string is no ObjectId.
void kit.as('ada');

// A config's shape decides what `KitOf` gives back.
type Kit = KitOf<typeof config>;
const sameKit: Kit = kit;
void sameKit;

// A key the driver's Db already answers to is refused where it is written.
void defineConfig({
	uri,
	// @ts-expect-error — "command" is a member of the driver's Db.
	collections: { command: users },
});

// …whichever shape the config was written in.
void defineConfig({
	databases: {
		// @ts-expect-error — "watch" is a member of the driver's Db.
		main: { uri, collections: { watch: users } },
	},
});

// @ts-expect-error — `posts` is not wired here.
void defineConfig({ uri, collections: { users }, optionsFor: { posts: {} } });

// @ts-expect-error — a kit decides the session itself.
void defineConfig({ uri, collections, options: { session: undefined } });

// @ts-expect-error — and the database it is on.
void defineConfig({ uri, collections, options: { db: undefined } });

// @ts-expect-error — and who writes, which `as` says.
void defineConfig({ uri, collections, options: { actor: undefined } });

// @ts-expect-error — and whether to sync, which the database's `autoSync` says.
void defineConfig({ uri, collections, options: { autoSync: true } });

// With several databases there is no `db` to read: each one is named.
const many = await createKit(
	defineConfig({
		databases: {
			main: { uri, collections },
			analytics: { uri, collections: { events } },
		},
	}),
);
void many.databases.main.users;
void many.databases.analytics.events;

// @ts-expect-error — `kit.db` is `never` once the kit holds several.
void many.db.users;

// @ts-expect-error — the kit has no database under that name.
void many.databases.nowhere;

// @ts-expect-error — nor a client under it.
void many.clients.nowhere;

// @ts-expect-error — a transaction runs on a database the kit has.
void many.transaction(async () => undefined, { on: 'nowhere' });

void many.transaction(
	async (tx) => {
		void tx.databases.main.users;
	},
	{ on: 'main' },
);

// Collections whose actors disagree leave nothing to stamp.
const counters = defineCollection({
	name: 'counters',
	schema: z.object({ _id: id(), n: z.number() }),
	actors: { type: z.string() },
});
const mixed = await createKit(
	defineConfig({ uri, collections: { posts, counters } }),
);

// @ts-expect-error — an ObjectId and a string agree on nothing.
void mixed.as(actor);

// A collection with no actor at all asks for none.
const quiet = await createKit(defineConfig({ uri, collections: { events } }));

// @ts-expect-error — nothing to stamp, so `as` takes nothing.
void quiet.as(objectId());

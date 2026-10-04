// What the Mongo refuses about buckets. Checked by `tsc --noEmit`, never run: a
// refusal that stops holding fails the typecheck on its unused directive.

import type { ObjectId } from 'mongodb';
import { defineMongo, openMongo } from '../../src';
import { defineBucket, type TypedBucket } from '../../src/gridfs';
import { avatars, buckets, collections, events, users } from '../wiring';

const uri = 'mongodb://127.0.0.1:1/unused';

const mongo = await openMongo(defineMongo({ uri, collections, buckets }));

// A bucket is the typed bucket, its metadata read as the schema says.
const bucket: TypedBucket<typeof avatars> = mongo.db.avatars;
void bucket;
const file = await mongo.db.avatars.put(new Uint8Array(1), {
	// An id may be given as its 24 hex characters, as on a collection.
	metadata: { userId: '68ca1f0f2b1c4d5e6f7a8b90', width: 64 },
});
const userId: ObjectId = file.metadata.userId;
const width: number | undefined = file.metadata.width;
void userId;
void width;

// @ts-expect-error — `widht` is no field of an avatar's metadata.
void mongo.db.avatars.put(new Uint8Array(1), { metadata: { widht: 64 } });

// @ts-expect-error — `width` is a number.
void mongo.db.avatars.put(new Uint8Array(1), { metadata: { width: 'wide' } });

// @ts-expect-error — `MAX_SIZE` is exported beside the buckets, and is none.
void mongo.db.MAX_SIZE;

// The collections are still there, beside the buckets.
void mongo.db.users.create({ email: 'ada@example.com' });

// `syncBuckets` reports under the database names, then the bucket keys.
void mongo.syncBuckets().then((reports) => {
	void reports.default.avatars;
	// @ts-expect-error — no bucket is wired under that key.
	void reports.default.nothing;
	// @ts-expect-error — nor a database under that name.
	void reports.main;
});

// @ts-expect-error — there is no `dryRun` to give: index creation has none.
void mongo.syncBuckets({ dryRun: true });

// A bucket under a key the driver's Db already answers to is refused.
void defineMongo({
	uri,
	collections,
	// @ts-expect-error — "watch" is a member of the driver's Db.
	buckets: { watch: defineBucket({ name: 'watch' }) },
});

// …and so is one under a key a collection already holds.
void defineMongo({
	uri,
	collections: { users },
	// @ts-expect-error — "users" is also a collection of this database.
	buckets: { users: avatars },
});

// …whichever shape the config was written in.
void defineMongo({
	databases: {
		// @ts-expect-error — "command" is a member of the driver's Db.
		main: { uri, collections, buckets: { command: avatars } },
	},
});

// The wiring decides the session and `autoSync`, even beside an allowed option.
void defineMongo({
	uri,
	collections,
	buckets,
	// @ts-expect-error — the session is the Mongo's.
	bucketOptions: { hash: false, session: undefined },
});
void defineMongo({
	uri,
	collections,
	buckets,
	// @ts-expect-error — and `autoSync` is the database's.
	bucketOptions: { hash: false, autoSync: true },
});

void defineMongo({
	uri,
	collections,
	// @ts-expect-error — no buckets, so no bucket options.
	bucketOptions: { hash: false },
});

// Several databases: each scope carries its own buckets, and only those.
const many = await openMongo(
	defineMongo({
		databases: {
			main: { uri, collections, buckets },
			analytics: { uri, collections: { events } },
		},
	}),
);
void many.databases.main.avatars;
// @ts-expect-error — the analytics database wires no bucket.
void many.databases.analytics.avatars;

// Inside a transaction the buckets are there, typed the same way.
void mongo.transaction(async (tx) => {
	const inTx: TypedBucket<typeof avatars> = tx.db.avatars;
	void inTx;
});

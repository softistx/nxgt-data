import type { Db, MongoClient } from 'mongodb';
import { mongoSource } from '../src/source/mongo-source';
import type { Harness } from './fixtures';

/** The scratch databases left on the server: there must be none. */
export async function scratchLeft(client: MongoClient): Promise<string[]> {
	const { databases } = await client.db('admin').admin().listDatabases();
	return databases
		.map((d) => d.name)
		.filter((name) => name.startsWith('nxgt-restore-'));
}

type Numbered = { _id: number } & Record<string, unknown>;

/**
 * A full backup of `a`, `other` and a view on `a`, then an incremental
 * renaming `a` to `orders`. Gives the incremental's id.
 */
export async function chain(db: Db, h: Harness): Promise<string> {
	await db.collection<Numbered>('a').insertMany([{ _id: 1 }, { _id: 2 }]);
	await db.collection('a').createIndex({ k: 1 }, { name: 'k' });
	await db.collection('other').insertOne({ n: 1 });
	await db.createCollection('ones', { viewOn: 'a', pipeline: [] });
	const source = mongoSource({ db });
	await h.backups.create(source);
	await db.collection<Numbered>('a').insertOne({ _id: 3 });
	await db.collection('a').rename('orders');
	await db.command({ collMod: 'ones', viewOn: 'orders', pipeline: [] });
	const created = await h.backups.create(source, {
		kind: 'incremental',
		identities: [h.identity],
	});
	return created.id;
}

/** `db`, whose listing of collections sees none: as if one came just after it. */
export function blind(db: Db): Db {
	return new Proxy(db, {
		get(target, key, receiver) {
			if (key !== 'listCollections') return Reflect.get(target, key, receiver);
			return () => ({ toArray: async () => [] });
		},
	});
}

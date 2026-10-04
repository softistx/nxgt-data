import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { BSON, type Db } from 'mongodb';

export interface Harness {
	path: string;
	identity: string;
	backups: ReturnType<typeof bindBackup<'db'>>;
	remove: () => Promise<void>;
}

/** A local repository in a fresh folder, and a binding to it with a fresh key. */
export async function harness(): Promise<Harness> {
	const path = await mkdtemp(join(tmpdir(), 'nxgt-mongo-backup-spec-'));
	const identity = await generateIdentity();
	const backups = bindBackup(defineBackup({ name: 'db' }), {
		repositories: [localRepository({ path: join(path, 'repo') })],
		recipients: [await identityToRecipient(identity)],
		tmpDir: path,
	});
	return {
		path,
		identity,
		backups,
		remove: () => rm(path, { recursive: true, force: true }),
	};
}

/**
 * Every collection of `db` and its documents, sorted by `_id`, as canonical
 * Extended JSON: two databases holding the same thing give the same text,
 * number kinds included.
 */
export async function contents(db: Db): Promise<Record<string, string>> {
	const found: Record<string, string> = {};
	const collections = await db
		.listCollections({}, { nameOnly: true })
		.toArray();
	for (const { name } of collections.sort((a, b) =>
		a.name < b.name ? -1 : 1,
	)) {
		if (name.startsWith('system.')) continue;
		const documents = await db
			.collection(name)
			.find({}, { promoteValues: false, bsonRegExp: true })
			.sort({ _id: 1 })
			.toArray();
		found[name] = BSON.EJSON.stringify(documents, { relaxed: false });
	}
	return found;
}

/** The indexes of one collection, without what differs between two databases. */
export async function indexesOf(db: Db, name: string) {
	const indexes = await db.collection(name).listIndexes().toArray();
	return indexes
		.map(({ v: _v, ns: _ns, ...index }) => index)
		.sort((a, b) => (a['name'] < b['name'] ? -1 : 1));
}

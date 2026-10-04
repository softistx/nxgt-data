import { MongoClient } from 'mongodb';
import { shopBackups } from './backups';

/**
 * `bun src/index.ts backup` hourly, `bun src/index.ts drill` daily. Each
 * prints its report as one line of JSON — ids, sizes, counts, never a key
 * nor a document — and exits non-zero on failure, for the scheduler to
 * alert on.
 */
const command = Bun.argv[2];
if (command !== 'backup' && command !== 'drill') {
	console.error('usage: bun src/index.ts backup|drill');
	process.exit(2);
}
const url = Bun.env['MONGO_URL'];
if (!url) {
	console.error('mongo-backup-job: set MONGO_URL');
	process.exit(2);
}
const client = await MongoClient.connect(url);
try {
	const backups = shopBackups(client);
	const report =
		command === 'backup' ? await backups.run() : await backups.drill();
	console.log(JSON.stringify(report));
} finally {
	await client.close();
}

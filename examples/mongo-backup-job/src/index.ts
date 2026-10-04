import { MongoClient } from 'mongodb';
import { configFromEnv } from './config';
import { backupJob, jobOf, restoreDrill } from './job';

/**
 * `bun src/index.ts backup` from a scheduler, hourly; `bun src/index.ts
 * drill` daily or weekly. Each prints its report as one line of JSON, and
 * exits non-zero on failure, so the scheduler's alerting sees it.
 */
const command = Bun.argv[2];
if (command !== 'backup' && command !== 'drill') {
	console.error('usage: bun src/index.ts backup|drill');
	process.exit(2);
}
const config = await configFromEnv();
const client = await MongoClient.connect(config.mongoUrl);
try {
	const job = jobOf(config, client.db(config.database));
	const report =
		command === 'backup' ? await backupJob(job) : await restoreDrill(job);
	console.log(JSON.stringify(report));
} finally {
	await client.close();
}

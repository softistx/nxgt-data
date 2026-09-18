import { createKit } from '@nxgt/mongo-kit';
import { config } from './db';

/**
 * The deployment step: `bun run sync` creates the collections, their
 * validators and their indexes. It is not the server's job — `collMod`
 * needs the `dbAdmin` role, and an index build runs outside any transaction.
 *
 * `--dry-run` reports what it would change and writes nothing.
 */
await using kit = await createKit(config);

const reports = await kit.sync({ dryRun: process.argv.includes('--dry-run') });
for (const [database, collections] of Object.entries(reports)) {
	for (const report of collections) {
		console.log(
			`${database}.${report.name}: ${report.created ? 'created' : 'in place'}, ` +
				`${report.indexes.created.length} index(es) created`,
		);
	}
}

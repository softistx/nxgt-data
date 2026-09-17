import type { Migration, MigrationConfig } from './types';

const ID = /^[\w.:-]+$/;

/**
 * A migration: an id it is recorded under, what it does, and optionally how
 * to undo it.
 *
 * ```ts
 * export const backfillSlug = defineMigration({
 * 	id: '2026-09-17-backfill-slug',
 * 	async up({ db, session }) {
 * 		await db
 * 			.collection('posts')
 * 			.updateMany({ slug: null }, [{ $set: { slug: '$title' } }], { session });
 * 	},
 * });
 * ```
 *
 * In a transaction, a retried attempt starts over from an aborted one, so
 * only what `up` does outside the session can happen twice. A migration with
 * `transaction: false` that fails is not recorded and runs again from the
 * start next time: write it so a second run changes nothing more.
 */
export function defineMigration(config: MigrationConfig): Migration {
	if (typeof config.id !== 'string' || !ID.test(config.id)) {
		throw new TypeError(
			`defineMigration: "${String(config.id)}" is not a migration id. ` +
				'Use letters, digits, "_", "-", "." and ":".',
		);
	}
	if (typeof config.up !== 'function') {
		throw new TypeError(`defineMigration: "${config.id}" has no up`);
	}
	if (config.down !== undefined && typeof config.down !== 'function') {
		throw new TypeError(
			`defineMigration: "${config.id}" has a down that is not a function`,
		);
	}
	return Object.freeze({
		id: config.id,
		up: config.up,
		down: config.down,
		transaction: config.transaction ?? true,
	});
}

import type { Db } from 'mongodb';
import type { AnyCollectionDefinition } from '../definition/define-collection';
import { syncCollection } from '../sync/sync-collection';

/**
 * The syncs `autoSync` has started, per database and per collection, so that
 * every collection of the same database waits on the same one — including the
 * ones `withSession` and `as` build, which are the same collection again.
 *
 * A sync that failed is forgotten, so the next call tries again: a server that
 * was not up yet is not a reason to refuse every operation for the life of the
 * process.
 */
let syncs = new WeakMap<Db, Map<string, Promise<unknown>>>();

/**
 * Forgets the syncs `autoSync` has already run, for one database or for all.
 *
 * The memo is what makes `autoSync` sync once and not before every call, and
 * it outlives the collection itself — a `dropDatabase` leaves this package
 * thinking a collection it can no longer see is in shape. A test that empties
 * its database between cases calls this alongside.
 */
export function resetAutoSync(db?: Db): void {
	if (db) syncs.delete(db);
	else syncs = new WeakMap();
}

function syncOnce(
	db: Db,
	definition: AnyCollectionDefinition,
): Promise<unknown> {
	let byName = syncs.get(db);
	if (!byName) {
		byName = new Map();
		syncs.set(db, byName);
	}
	const started = byName.get(definition.name);
	if (started) return started;
	const running = syncCollection(db, definition);
	byName.set(definition.name, running);
	running.catch(() => byName.delete(definition.name));
	return running;
}

/**
 * What does not wait for `autoSync`: the properties, the two that build
 * another collection, and `sync` itself.
 */
const UNGATED = new Set([
	'definition',
	'db',
	'raw',
	'session',
	'withSession',
	'as',
	'sync',
]);

/**
 * A method of the collection, made to wait for the sync first — or the value
 * itself, when it is not one of the methods that should.
 *
 * The sync is looked up per call, not captured when the collection is built:
 * that is one map lookup, and it is what lets `resetAutoSync` reach a
 * collection somebody is already holding.
 */
export function gated(
	db: Db,
	definition: AnyCollectionDefinition,
	key: string | symbol,
	value: unknown,
): unknown {
	if (typeof value !== 'function' || UNGATED.has(key as string)) return value;
	return (...args: unknown[]) =>
		syncOnce(db, definition).then(() =>
			(value as (...a: unknown[]) => unknown)(...args),
		);
}

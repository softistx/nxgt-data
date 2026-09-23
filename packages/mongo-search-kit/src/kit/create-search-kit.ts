import type { SyncReport, TypedIndex } from '@nxgt/meilisearch';
import type { AnyCollectionDefinition, TypedCollection } from '@nxgt/mongo';
import type { MongoKit } from '@nxgt/mongo-kit';
import {
	createSearchSync,
	type ReindexReport,
	type RunningSearchSync,
	type SearchSync,
	type SearchSyncState,
} from '@nxgt/mongo-meilisearch';
import type { IndexMap, SearchConfig } from '../config/types';
import type { ByKey, RunningSearchKit, SearchKit } from './types';

/** The kit's sole scope, or a refusal naming what to do instead. */
function soleScope(kit: MongoKit<unknown>): Record<string, unknown> {
	const names = Object.keys(kit.databases);
	if (names.length !== 1) {
		throw new TypeError(
			'createSearchKit: this kit holds ' +
				`${names.length} databases (${names.join(', ')}), and a search kit ` +
				'follows the collections of one. Build one search kit per database, ' +
				'from a kit that wires that database alone',
		);
	}
	return kit.db as unknown as Record<string, unknown>;
}

/** The collection a key names, refused by name when the kit wires none. */
function collectionAt(
	scope: Record<string, unknown>,
	key: string,
): TypedCollection<AnyCollectionDefinition> {
	const collection = scope[key];
	// A `Db` answers to its own members, so a key that is one would give
	// something that is not a collection rather than `undefined`. A GridFS
	// bucket the kit wires has a `definition` too, so it is the definition's
	// shape that decides: a collection's has a schema, a bucket's has none.
	const definition =
		typeof collection === 'object' && collection !== null
			? (collection as { definition?: unknown }).definition
			: undefined;
	if (
		typeof definition !== 'object' ||
		definition === null ||
		!('schema' in definition)
	) {
		throw new TypeError(
			`createSearchKit: this kit wires no collection called "${key}"`,
		);
	}
	return collection as TypedCollection<AnyCollectionDefinition>;
}

/**
 * The search kit: one `createSearchSync` per entry, over the collections the
 * Mongo kit already holds.
 *
 * It is an object of its own rather than something added to the kit: the
 * Mongo kit stays as `createKit` returned it, and each of the two is closed
 * by whoever opened it. The search kit closes only what it started — the
 * collections, the client and the database are the Mongo kit's.
 */
export function createSearchKit<C, const I extends IndexMap<I>>(
	kit: MongoKit<C>,
	config: SearchConfig<C, I>,
): SearchKit<I> {
	const scope = soleScope(kit as MongoKit<unknown>);
	const keys = Object.keys(config) as (keyof I & string)[];

	const syncs = {} as Record<keyof I & string, SearchSync>;
	const indexes = {} as Record<keyof I & string, TypedIndex<never>>;
	for (const key of keys) {
		const entry = config[key] as unknown as Record<string, unknown>;
		indexes[key] = entry.index as TypedIndex<never>;
		syncs[key] = createSearchSync({
			...entry,
			collection: collectionAt(scope, key),
		} as Parameters<typeof createSearchSync>[0]);
	}

	return {
		syncs: syncs as ByKey<I, SearchSync>,

		async state() {
			const state = {} as Record<keyof I & string, SearchSyncState | undefined>;
			for (const key of keys) state[key] = await syncs[key].state();
			return state as ByKey<I, SearchSyncState | undefined>;
		},

		async syncIndexes(options) {
			const reports = {} as Record<keyof I & string, SyncReport>;
			for (const key of keys) reports[key] = await indexes[key].sync(options);
			return reports as ByKey<I, SyncReport>;
		},

		async reindexAll() {
			const reports = {} as Record<keyof I & string, ReindexReport>;
			for (const key of keys) reports[key] = await syncs[key].reindex();
			return reports as ByKey<I, ReindexReport>;
		},

		async start() {
			const running = {} as Record<keyof I & string, RunningSearchSync>;
			const started: RunningSearchSync[] = [];
			for (const key of keys) {
				let one: RunningSearchSync;
				try {
					one = await syncs[key].start();
				} catch (error) {
					// Nothing half-started: a caller that catches this owns no sync.
					await Promise.allSettled(started.map((it) => it.close()));
					throw error;
				}
				// Taken the moment the sync exists, not once the loop is done: a
				// later `start` reindexes when its key has nothing recorded, which
				// is minutes on a real collection, and this sync is already
				// following changes throughout. A `closed` that rejects with
				// nobody listening ends the process.
				one.closed.catch(() => undefined);
				running[key] = one;
				started.push(one);
			}
			return runningKit(running as ByKey<I, RunningSearchSync>, started);
		},
	};
}

/** The started kit: what `start` hands over. */
function runningKit<S>(
	running: ByKey<S, RunningSearchSync>,
	started: RunningSearchSync[],
): RunningSearchKit<S> {
	let closing: Promise<void> | undefined;

	// `closed` resolves on a clean stop and rejects on a failure. Only the
	// rejections are interesting here, so a resolution is turned into a
	// promise that never settles — `failed` is what a caller awaits.
	//
	// The sync whose rejection wins the race is kept, because that is the one
	// `failed` reports: `close` stays quiet about that one alone, and still
	// throws a *second* sync's failure, which `failed` can no longer carry.
	let reported: RunningSearchSync | undefined;
	const failed = Promise.race(
		started.map((one) =>
			one.closed.then(
				() => new Promise<never>(() => {}),
				(reason: unknown) => {
					reported ??= one;
					throw reason;
				},
			),
		),
	);
	// And `failed` itself is taken, so that a caller who never looks at it
	// does not end the process either.
	failed.catch(() => undefined);

	const close = () => {
		closing ??= (async () => {
			let first: unknown;
			let caught = false;
			for (const one of started) {
				try {
					await one.close();
				} catch (error) {
					// The sync `failed` reported rejects `close` with what it
					// stopped on. That is `failed`'s to report, not this one's — a
					// caller should not have to wrap `close` to hear it twice. Any
					// other failure, and anything that goes wrong *while* closing,
					// is thrown: the first of them.
					if (one === reported || caught) continue;
					first = error;
					caught = true;
				}
			}
			if (caught) throw first;
		})();
		return closing;
	};

	return {
		running,
		failed,
		async flush() {
			for (const one of started) await one.flush();
		},
		close,
		[Symbol.asyncDispose]: close,
	};
}

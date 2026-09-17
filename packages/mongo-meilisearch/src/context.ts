import type { AnyIndexDefinition, TypedIndex } from '@nxgt/meilisearch';
import type { AnyCollectionDefinition, TypedCollection } from '@nxgt/mongo';
import type { Collection } from 'mongodb';
import type { SearchSyncOptions, SearchSyncState } from './types';

/** Loosely typed: this layer works on any documents; the public types are what callers see. */
export type Doc = Record<string, unknown>;

/**
 * What a sync works from, resolved once. Data, and the caller's own two
 * functions as they were given.
 */
export interface SyncContext {
	readonly name: string;
	readonly collection: TypedCollection<AnyCollectionDefinition>;
	readonly index: TypedIndex<AnyIndexDefinition>;
	readonly primaryKey: string;
	readonly state: Collection<SearchSyncState>;
	readonly batchSize: number;
	readonly flushIntervalMs: number;
	readonly positionIntervalMs: number;
	readonly pageSize: number;
	readonly onHistoryLost: 'reindex' | 'fail';
	readonly transform: (document: Doc) => unknown;
	readonly toIndexId: (id: unknown) => unknown;
	/**
	 * Whether this sync is following changes in this process. A reindex
	 * beside its own follower would remove what the follower has just
	 * indexed, and the follower would never send it again.
	 */
	readonly follower: { running: boolean };
}

const DEFAULT_STATE_COLLECTION = 'nxgt_search_sync';

function positive(option: string, value: number | undefined, fallback: number) {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1) {
		throw new TypeError(
			`createSearchSync: ${option} must be a whole number above 0, not ${String(value)}`,
		);
	}
	return resolved;
}

export function createContext(
	options: SearchSyncOptions<AnyCollectionDefinition, AnyIndexDefinition>,
): SyncContext {
	const { collection, index } = options;
	if (typeof options.transform !== 'function') {
		throw new TypeError('createSearchSync: transform must be a function');
	}
	const name = options.name ?? `${collection.collectionName}:${index.uid}`;
	if (name === '') {
		throw new TypeError('createSearchSync: name must not be empty');
	}
	const flushIntervalMs = options.flushIntervalMs ?? 1000;
	if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 0) {
		throw new TypeError(
			`createSearchSync: flushIntervalMs must be a whole number of milliseconds, not ${String(options.flushIntervalMs)}`,
		);
	}
	return {
		name,
		collection,
		index,
		primaryKey: index.definition.primaryKey as string,
		state: collection.db.collection<SearchSyncState>(
			options.stateCollection ?? DEFAULT_STATE_COLLECTION,
		),
		batchSize: positive('batchSize', options.batchSize, 500),
		positionIntervalMs: positive(
			'positionIntervalMs',
			options.positionIntervalMs,
			60_000,
		),
		flushIntervalMs,
		pageSize: positive('pageSize', options.pageSize, 100),
		onHistoryLost: options.onHistoryLost ?? 'reindex',
		transform: options.transform as (document: Doc) => unknown,
		toIndexId: (options.toIndexId ?? String) as (id: unknown) => unknown,
		follower: { running: false },
	};
}

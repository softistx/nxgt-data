import type { CursorPage } from '@nxgt/drizzle';
import type { AnyIndexDefinition, TypedIndex } from '@nxgt/meilisearch';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { SearchSyncOptions } from './types';

/**
 * Loosely typed: this layer works on any row and any document; the public
 * types in `types.ts` are what a caller sees.
 */
export type Doc = Record<string, unknown>;

/** The repository, as the layers below it read it. */
export interface LooseRepository {
	readonly table: PgTable;
	paginateByCursor(options?: {
		after?: string | null | undefined;
		limit?: number;
	}): Promise<CursorPage<Doc>>;
}

/**
 * What a sync works from, resolved once. Data, and the caller's own two
 * functions as they were given.
 */
export interface SyncContext {
	readonly name: string;
	readonly repository: LooseRepository;
	readonly index: TypedIndex<AnyIndexDefinition>;
	readonly primaryKey: string;
	readonly batchSize: number;
	readonly pageSize: number;
	readonly transform: (row: Doc) => unknown;
	readonly toIndexId: (row: Doc) => unknown;
}

/**
 * A whole number above 0, or the refusal — which names the call, because
 * `pageSize` is given to `createSearchSync` and again to `reindexAll`, and a
 * message that named only the option would point at the wrong one.
 */
export function positive(
	call: string,
	option: string,
	value: number | undefined,
	fallback: number,
) {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1) {
		throw new TypeError(
			`${call}: ${option} must be a whole number above 0, not ${String(value)}`,
		);
	}
	return resolved;
}

export function createContext(
	options: SearchSyncOptions<PgTable, AnyIndexDefinition>,
): SyncContext {
	const { repository, index } = options;
	if (typeof options.transform !== 'function') {
		throw new TypeError('createSearchSync: transform must be a function');
	}
	if (typeof options.toIndexId !== 'function') {
		// Required where the Mongo bridge defaults it to `String`: there, the
		// id is `_id` on every document; here, no column is known to be the
		// primary key at the type level, so nothing could be defaulted to.
		throw new TypeError('createSearchSync: toIndexId must be a function');
	}
	const name = options.name ?? `${getTableName(repository.table)}:${index.uid}`;
	if (name === '') {
		throw new TypeError('createSearchSync: name must not be empty');
	}
	return {
		name,
		repository: repository as LooseRepository,
		index,
		primaryKey: index.definition.primaryKey as string,
		batchSize: positive(
			'createSearchSync',
			'batchSize',
			options.batchSize,
			500,
		),
		pageSize: positive('createSearchSync', 'pageSize', options.pageSize, 100),
		transform: options.transform as (row: Doc) => unknown,
		toIndexId: options.toIndexId as (row: Doc) => unknown,
	};
}

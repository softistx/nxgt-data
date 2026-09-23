import type { Index, Meilisearch, RecordAny } from 'meilisearch';
import type { AnyIndexDefinition } from '../definition/define-index';

/**
 * What every method of a typed index works from, resolved once: the
 * definition, its uid and primary key, the client and the SDK's own index.
 *
 * It holds **data only**. The operations are plain functions that take it as
 * their first argument, in `operations/reads.ts` and `operations/writes.ts`.
 */
export interface IndexContext {
	readonly definition: AnyIndexDefinition;
	readonly client: Meilisearch;
	readonly uid: string;
	readonly primaryKey: AnyIndexDefinition['primaryKey'];
	/** The SDK's index, typed loosely: the public type is what callers see. */
	readonly raw: Index<RecordAny>;
}

export function createContext(
	client: Meilisearch,
	definition: AnyIndexDefinition,
): IndexContext {
	const { uid, primaryKey } = definition;
	return {
		definition,
		client,
		uid,
		primaryKey,
		raw: client.index<RecordAny>(uid),
	};
}

/** The SDK types documents as mutable records; they are only read. */
export function records(documents: readonly unknown[]): RecordAny[] {
	return documents as RecordAny[];
}

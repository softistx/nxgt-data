/**
 * How entries are named: `metadata/<collection>` (its options and indexes,
 * as canonical Extended JSON), `documents/<collection>` (its documents, as
 * concatenated BSON, the format `mongodump` writes), `changes/<n>` (the
 * changes an incremental or differential backup read, as concatenated BSON,
 * numbered in the order they apply).
 */
export const METADATA = 'metadata/';
export const DOCUMENTS = 'documents/';
export const CHANGES = 'changes/';

export type EntryName =
	| { kind: 'metadata' | 'documents'; collection: string }
	| { kind: 'changes'; sequence: number };

/** What an entry name says, or nothing when it is not one this version writes. */
export function parseName(name: string): EntryName | undefined {
	for (const [prefix, kind] of [
		[METADATA, 'metadata'],
		[DOCUMENTS, 'documents'],
	] as const) {
		if (name.startsWith(prefix) && name.length > prefix.length) {
			return { kind, collection: name.slice(prefix.length) };
		}
	}
	if (name.startsWith(CHANGES)) {
		const digits = name.slice(CHANGES.length);
		if (/^\d{6,9}$/.test(digits)) {
			return { kind: 'changes', sequence: Number.parseInt(digits, 10) };
		}
	}
	return undefined;
}

/** The name of the `sequence`th changes entry. */
export function changesName(sequence: number): string {
	return `${CHANGES}${String(sequence).padStart(6, '0')}`;
}

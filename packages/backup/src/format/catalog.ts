export const CATALOG_FORMAT = 'nxgt-backup-catalog/1';

/** One entry of a backup, as its source named it, before compression. */
export interface CatalogEntry {
	/** The name the source gave it: a relative path, a collection's name. */
	name: string;
	/** The object holding it, relative to the backup's folder. */
	object: string;
	/** Its size in bytes, as the source gave it. */
	size: number;
	/** The SHA-256 of the bytes the source gave, in hex. */
	sha256: string;
}

/**
 * What a backup holds, encrypted like its data: the source's kind and every
 * entry's name. Kept apart from the manifest so that the names, which can
 * say a lot about what is stored, never sit in a repository in the clear.
 */
export interface Catalog {
	format: typeof CATALOG_FORMAT;
	source: { kind: string };
	entries: CatalogEntry[];
}

const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `name` can name an entry: not empty, at most 4096 characters, no NUL. */
export function isEntryName(name: unknown): name is string {
	return (
		typeof name === 'string' &&
		name.length > 0 &&
		name.length <= 4096 &&
		!name.includes('\0')
	);
}

function entryProblem(value: unknown, index: number): string | undefined {
	if (!isRecord(value)) return 'an entry is not a record';
	if (!isEntryName(value['name'])) return 'an entry name is not one';
	if (value['object'] !== `${index}.age`) {
		return 'its entries do not follow the objects';
	}
	const size = value['size'];
	if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
		return 'an entry size is not a whole number of bytes';
	}
	if (typeof value['sha256'] !== 'string' || !SHA256.test(value['sha256'])) {
		return 'an entry sha256 is not 64 hex digits';
	}
	return undefined;
}

/**
 * The catalog a backup's `catalog.age` decrypted to, or why it is not one.
 * `objects` is how many objects the manifest lists: the two must agree.
 */
export function readCatalog(text: string, objects: number): Catalog | string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return 'it is not JSON';
	}
	if (!isRecord(value) || value['format'] !== CATALOG_FORMAT) {
		return 'it is not an nxgt-backup catalog';
	}
	const source = value['source'];
	if (!isRecord(source) || typeof source['kind'] !== 'string') {
		return 'its source has no kind';
	}
	const entries = value['entries'];
	if (!Array.isArray(entries) || entries.length !== objects) {
		return 'its entries do not match the manifest';
	}
	const names = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		const problem = entryProblem(entry, index);
		if (problem) return problem;
		const name = (entry as CatalogEntry).name;
		if (names.has(name)) return 'two entries have the same name';
		names.add(name);
	}
	return {
		format: CATALOG_FORMAT,
		source: { kind: source['kind'] },
		entries: (entries as CatalogEntry[]).map((entry) => ({
			name: entry.name,
			object: entry.object,
			size: entry.size,
			sha256: entry.sha256,
		})),
	};
}

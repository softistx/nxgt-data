import { isBackupId } from './ids';

export const CATALOG_FORMAT = 'nxgt-backup-catalog/1';

/** The longest `fingerprint` a source can give an entry, in UTF-8 bytes. */
export const FINGERPRINT_MAX = 1024;

/** The longest `position` a source can record, in UTF-8 bytes. */
export const POSITION_MAX = 64 * 1024;

/** One entry of a backup, as its source named it, before compression. */
export interface CatalogEntry {
	/** The name the source gave it: a relative path, a collection's name. */
	name: string;
	/** The object holding it, relative to the folder of the backup holding it. */
	object: string;
	/**
	 * The backup holding its object, when it is not this one: an older
	 * backup of its chain, which stored it and which this one builds on.
	 */
	in?: string | undefined;
	/** Its size in bytes, as the source gave it. */
	size: number;
	/** The SHA-256 of the bytes the source gave, in hex. */
	sha256: string;
	/** What the source said of it without reading it: see `SourceEntry`. */
	fingerprint?: string | undefined;
}

/**
 * What a backup holds, encrypted like its data: the source's kind and every
 * entry's name. Kept apart from the manifest so that the names, which can
 * say a lot about what is stored, never sit in a repository in the clear.
 * It lists every entry the backup restores, wherever its object is.
 */
export interface Catalog {
	format: typeof CATALOG_FORMAT;
	source: { kind: string };
	entries: CatalogEntry[];
	/** Where the source was when it was read: see `BackupSource.position`. */
	position?: string | undefined;
}

const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT = /^\d{1,9}\.age$/;

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

/** Whether `value` is absent, or a string of at most `max` bytes in UTF-8. */
export function isOptionalText(value: unknown, max: number): boolean {
	return (
		value === undefined ||
		(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max)
	);
}

/**
 * Why `value` is not an entry, or nothing. `own` is how many entries
 * before it this backup stores itself: its own objects follow them.
 */
function entryProblem(value: unknown, own: number): string | undefined {
	if (!isRecord(value)) return 'an entry is not a record';
	if (!isEntryName(value['name'])) return 'an entry name is not one';
	if (value['in'] === undefined) {
		if (value['object'] !== `${own}.age`) {
			return 'its entries do not follow the objects';
		}
	} else if (
		!isBackupId(value['in']) ||
		typeof value['object'] !== 'string' ||
		!OBJECT.test(value['object'])
	) {
		return 'an entry stored elsewhere does not say where';
	}
	const size = value['size'];
	if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
		return 'an entry size is not a whole number of bytes';
	}
	if (typeof value['sha256'] !== 'string' || !SHA256.test(value['sha256'])) {
		return 'an entry sha256 is not 64 hex digits';
	}
	if (!isOptionalText(value['fingerprint'], FINGERPRINT_MAX)) {
		return 'an entry fingerprint is not one';
	}
	return undefined;
}

function entriesProblem(
	entries: unknown[],
	objects: number,
): string | undefined {
	const names = new Set<string>();
	let own = 0;
	for (const entry of entries) {
		const problem = entryProblem(entry, own);
		if (problem) return problem;
		const { name, in: elsewhere } = entry as CatalogEntry;
		if (names.has(name)) return 'two entries have the same name';
		names.add(name);
		if (elsewhere === undefined) own++;
	}
	return own === objects ? undefined : 'its entries do not match the manifest';
}

function keep(entry: CatalogEntry): CatalogEntry {
	return {
		name: entry.name,
		object: entry.object,
		...(entry.in === undefined ? {} : { in: entry.in }),
		size: entry.size,
		sha256: entry.sha256,
		...(entry.fingerprint === undefined
			? {}
			: { fingerprint: entry.fingerprint }),
	};
}

/**
 * The catalog a backup's `catalog.age` decrypted to, or why it is not one.
 * `objects` is how many objects the manifest lists: as many entries must
 * be stored in this backup itself.
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
	if (!isOptionalText(value['position'], POSITION_MAX)) {
		return 'its position is not one';
	}
	const entries = value['entries'];
	if (!Array.isArray(entries)) return 'its entries do not match the manifest';
	const problem = entriesProblem(entries, objects);
	if (problem) return problem;
	const position = value['position'] as string | undefined;
	return {
		format: CATALOG_FORMAT,
		source: { kind: source['kind'] },
		entries: (entries as CatalogEntry[]).map(keep),
		...(position === undefined ? {} : { position }),
	};
}

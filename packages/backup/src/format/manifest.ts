import { isBackupName } from '../definition/define-backup';
import { isBackupId } from './ids';

export const MANIFEST_FORMAT = 'nxgt-backup/1';

/**
 * The largest manifest read or written: about half a million entries at
 * some 130 bytes each. A repository is not trusted with the size, so a
 * read stops here; `create` refuses to write one it could not read back.
 */
export const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;

/** An object of a backup, as the repository holds it: encrypted bytes. */
export interface StoredObject {
	/** Its key, relative to the backup's folder: `0.age`, `catalog.age`. */
	key: string;
	/** Its size in bytes, encrypted. */
	size: number;
	/** The SHA-256 of its encrypted bytes, in hex. */
	sha256: string;
}

/**
 * What a repository holds in the clear for one backup, written **last**: a
 * backup exists once this does. It names no entry — the names are in the
 * catalog, which is encrypted — so a repository's listing, its integrity
 * check and its rotation all work without a key.
 */
export interface Manifest {
	format: typeof MANIFEST_FORMAT;
	backup: string;
	id: string;
	/** When the backup started, as an ISO date. */
	createdAt: string;
	kind: 'full';
	parent: null;
	/** The public keys it is encrypted to: `age1…`, `age1pq1…`. */
	recipients: string[];
	compression: 'zstd';
	catalog: StoredObject;
	objects: StoredObject[];
}

const OBJECT_KEY = /^(?:\d{1,9}|catalog)\.age$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Problem = string;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectProblem(value: unknown): Problem | undefined {
	if (!isRecord(value)) return 'an object is not a record';
	if (typeof value['key'] !== 'string' || !OBJECT_KEY.test(value['key'])) {
		return 'an object key is not one this format writes';
	}
	const size = value['size'];
	if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
		return 'an object size is not a whole number of bytes';
	}
	if (typeof value['sha256'] !== 'string' || !SHA256.test(value['sha256'])) {
		return 'an object sha256 is not 64 hex digits';
	}
	return undefined;
}

function shapeProblem(value: Record<string, unknown>): Problem | undefined {
	if (value['format'] !== MANIFEST_FORMAT) {
		return typeof value['format'] === 'string' &&
			value['format'].startsWith('nxgt-backup/')
			? 'its format is one this version does not read'
			: 'it is not an nxgt-backup manifest';
	}
	if (!isBackupName(value['backup'])) return 'its backup name is not one';
	if (!isBackupId(value['id'])) return 'its id is not a backup id';
	const createdAt = value['createdAt'];
	if (
		typeof createdAt !== 'string' ||
		Number.isNaN(Date.parse(createdAt)) ||
		new Date(createdAt).toISOString() !== createdAt
	) {
		return 'its createdAt is not an ISO date';
	}
	if (value['kind'] !== 'full' || value['parent'] !== null) {
		return 'its kind is not one this version reads';
	}
	if (value['compression'] !== 'zstd') return 'its compression is not zstd';
	const recipients = value['recipients'];
	if (
		!Array.isArray(recipients) ||
		recipients.length === 0 ||
		!recipients.every((r) => typeof r === 'string' && r.startsWith('age1'))
	) {
		return 'its recipients are not age public keys';
	}
	return undefined;
}

function objectsProblem(value: Record<string, unknown>): Problem | undefined {
	const catalog = objectProblem(value['catalog']);
	if (catalog) return catalog;
	if ((value['catalog'] as StoredObject).key !== 'catalog.age') {
		return 'its catalog key is not catalog.age';
	}
	const objects = value['objects'];
	if (!Array.isArray(objects)) return 'its objects are not a list';
	for (const [index, object] of objects.entries()) {
		const problem = objectProblem(object);
		if (problem) return problem;
		if ((object as StoredObject).key !== `${index}.age`) {
			return 'its objects are not numbered in order';
		}
	}
	return undefined;
}

/**
 * The manifest a repository returned, checked field by field, or why it is
 * not one. The repository is not trusted: a manifest is read as untrusted
 * input, and only its known fields are kept.
 */
export function readManifest(text: string): Manifest | Problem {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return 'it is not JSON';
	}
	if (!isRecord(value)) return 'it is not a JSON object';
	const problem = shapeProblem(value) ?? objectsProblem(value);
	if (problem) return problem;
	const keep = (object: StoredObject): StoredObject => ({
		key: object.key,
		size: object.size,
		sha256: object.sha256,
	});
	return {
		format: MANIFEST_FORMAT,
		backup: value['backup'] as string,
		id: value['id'] as string,
		createdAt: value['createdAt'] as string,
		kind: 'full',
		parent: null,
		recipients: [...(value['recipients'] as string[])],
		compression: 'zstd',
		catalog: keep(value['catalog'] as StoredObject),
		objects: (value['objects'] as StoredObject[]).map(keep),
	};
}

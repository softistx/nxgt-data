import { BSON, type Document } from 'mongodb';
import { isDocument } from './document';

const METADATA_FORMAT = 'nxgt-mongo-backup-metadata/1';

/** What a backup records of a collection or a view, besides its documents. */
export interface Metadata {
	type: 'collection' | 'view';
	/** What `listCollections` gave as its options: validator, collation, capped… */
	options: Document;
	/** Its indexes as `listIndexes` gave them, `_id` apart. */
	indexes: Document[];
}

/** `metadata` as the backup records it: canonical Extended JSON. */
export function writeMetadata(metadata: Metadata): string {
	return BSON.EJSON.stringify(
		{ format: METADATA_FORMAT, ...metadata },
		{ relaxed: false },
	);
}

/** The metadata an entry holds, or nothing when it is not one this version wrote. */
export function readMetadata(text: string): Metadata | undefined {
	let value: unknown;
	try {
		value = BSON.EJSON.parse(text, { relaxed: false });
	} catch {
		return undefined;
	}
	if (!isDocument(value) || value['format'] !== METADATA_FORMAT) {
		return undefined;
	}
	const { type, options, indexes } = value;
	if (
		(type !== 'collection' && type !== 'view') ||
		!isDocument(options) ||
		!Array.isArray(indexes) ||
		!indexes.every(
			(index) => isDocument(index) && typeof index['name'] === 'string',
		)
	) {
		return undefined;
	}
	return { type, options, indexes: indexes as Document[] };
}

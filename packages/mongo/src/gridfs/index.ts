// The errors this subpath raises, so that catching one does not mean importing
// the root package beside it. They are the very same classes: `instanceof`
// holds across both entry points.
export {
	ConflictError,
	CorruptFileError,
	DataError,
	type DataErrorCode,
	InvalidCursorError,
	InvalidIdError,
	NotFoundError,
	ValidationError,
} from '../errors/data-error';
export type { BucketOptions } from './context';
export { defineBucket } from './define-bucket';
export {
	getFiles,
	type PutOnceOptions,
	type TypedBucket,
	type TypedPutOptions,
} from './get-files';
export {
	type ByteRange,
	FileHandle,
	type ResponseInit as FileResponseInit,
	type StoredFile,
} from './handle';
export { type BucketIndexReport, resetBucketSync } from './indexes';
export type { FilePageOptions } from './operations/paginate';
export type { PutOnceResult } from './operations/put-once';
export type { PutOptions } from './operations/writes';
export { parseRange } from './serve';
export type { FileSource } from './source';
export type {
	BucketConfig,
	BucketDefinition,
	FileId,
	MetadataAsGiven,
	MetadataOf,
	MetadataSchema,
} from './types';

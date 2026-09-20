// What does not depend on a dialect: the errors, the cursor and the page
// shapes. The PostgreSQL helpers are in `@nxgt/drizzle/pg`.

export { ArgumentError } from './errors/argument-error';
export type { DataErrorCode, DataErrorOptions } from './errors/data-error';
export {
	CheckViolationError,
	ConflictError,
	DataError,
	ForeignKeyError,
	InvalidCursorError,
	NotFoundError,
	NotNullViolationError,
} from './errors/data-error';
export { toDataError } from './errors/to-data-error';
export type { CursorPayload } from './pagination/cursor';
export { decodeCursor, encodeCursor } from './pagination/cursor';
export type {
	CursorPage,
	Page,
	PageOptions,
	PageWindow,
} from './pagination/page';
export {
	DEFAULT_MAX_PAGE_SIZE,
	DEFAULT_PAGE_SIZE,
	pageWindow,
	toPage,
} from './pagination/page';

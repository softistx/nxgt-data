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
	InvalidValueError,
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
	// `cursorLimit` beside `pageWindow`, as `@nxgt/mongo` already exports it:
	// a caller paginating something of their own could reach the offset half
	// of this and not the cursor half, for no reason anybody wrote down.
	cursorLimit,
	DEFAULT_MAX_PAGE_SIZE,
	DEFAULT_PAGE_SIZE,
	pageWindow,
	toPage,
} from './pagination/page';

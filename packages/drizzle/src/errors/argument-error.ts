/**
 * An argument this package refuses before any SQL is built.
 *
 * `DataError` and its subclasses are what the **database** said. This is what
 * the *call* said, and the two are worth telling apart: a `where` or an
 * `orderBy` assembled from a query string is user input, so a handler that
 * wants to answer 400 rather than 500 needs to recognise it without matching
 * the message text.
 *
 * It extends `TypeError`, not `Error`, because that is what these were before
 * it existed — every `catch` that tests for `TypeError` keeps working.
 */
export class ArgumentError extends TypeError {
	override name = 'ArgumentError';
	readonly code = 'INVALID_ARGUMENT' as const;
	/**
	 * The argument it is about — `where`, `orderBy` — or the call, when the
	 * argument has no name of its own: `paginateByCursor` names the column
	 * key it was ordered by.
	 */
	readonly argument: string;
	/** The key inside that argument, when one is at fault. */
	readonly key: string | undefined;

	constructor(
		argument: string,
		message: string,
		options?: { key?: string | undefined; cause?: unknown },
	) {
		super(
			message,
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
		this.argument = argument;
		this.key = options?.key;
	}
}

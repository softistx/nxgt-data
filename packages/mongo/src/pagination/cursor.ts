import { ObjectId } from 'mongodb';
import { InvalidCursorError } from '../errors/data-error';

/** What a cursor holds: the ordering values of the last document of a page. */
export interface CursorPayload {
	/** The ordering it was written for: `<field>:<asc|desc>`. */
	readonly key: string;
	readonly values: readonly unknown[];
}

/** An `ObjectId`, read without `instanceof`: two copies of the driver. */
function isObjectId(value: unknown): value is ObjectId {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { _bsontype?: unknown })._bsontype === 'ObjectId'
	);
}

// JSON has no Date, no bigint and no ObjectId, and a cursor must give back the
// very value it was written from: a Date compares with a date field, an
// ObjectId with `_id`. `JSON.stringify` has already called `toJSON` by the time
// the replacer runs, so the raw value is read off `this`.
function replacer(this: Record<string, unknown>, key: string, value: unknown) {
	const raw = this[key];
	if (raw instanceof Date) return { $date: raw.toISOString() };
	if (typeof raw === 'bigint') return { $bigint: raw.toString() };
	if (isObjectId(raw)) return { $oid: raw.toHexString() };
	return value;
}

function reviver(_key: string, value: unknown): unknown {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const keys = Object.keys(value);
		if (keys.length === 1) {
			const tagged = value as {
				$date?: unknown;
				$bigint?: unknown;
				$oid?: unknown;
			};
			if (typeof tagged.$date === 'string') return new Date(tagged.$date);
			if (typeof tagged.$bigint === 'string') return BigInt(tagged.$bigint);
			if (typeof tagged.$oid === 'string') return new ObjectId(tagged.$oid);
		}
	}
	return value;
}

function toBase64Url(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
	const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
	return new TextDecoder().decode(
		Uint8Array.from(binary, (char) => char.charCodeAt(0)),
	);
}

/**
 * Writes an opaque, URL-safe cursor. `Date`, `bigint` and `ObjectId` values
 * survive the round trip. It is encoded, not signed: a client can read it,
 * and forge one.
 */
export function encodeCursor(payload: CursorPayload): string {
	return toBase64Url(JSON.stringify([payload.key, payload.values], replacer));
}

/**
 * Reads a cursor `encodeCursor` wrote. Throws `InvalidCursorError` for
 * anything else, and for a cursor written for another ordering when
 * `expectedKey` is given.
 *
 * `where` names the call it came from, so the sentence reads `Invalid cursor
 * in paginateByCursor on "users": unexpected shape`: every paginated call
 * takes the same `after`, and the message on its own named none of them. The
 * lead stays where it was, because that is the part a consumer searches for.
 * It is optional: this is exported for a caller paginating something this
 * package knows nothing about.
 */
export function decodeCursor(
	cursor: string,
	expectedKey?: string,
	where?: string,
	collection?: string,
): CursorPayload {
	const at = where ? ` in ${where}` : '';
	// The collection on the error as well as in the sentence: the refusal below
	// is the caller's to answer with a 400, and a handler that logs which
	// listing failed should not have to parse a message to find out. The
	// value-count refusal, thrown where this is called, already carries it.
	const on = { collection };
	let parsed: unknown;
	try {
		parsed = JSON.parse(fromBase64Url(cursor), reviver);
	} catch (cause) {
		throw new InvalidCursorError(`Invalid cursor${at}: it cannot be decoded`, {
			...on,
			cause,
		});
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 2 ||
		typeof parsed[0] !== 'string' ||
		!Array.isArray(parsed[1])
	) {
		throw new InvalidCursorError(`Invalid cursor${at}: unexpected shape`, on);
	}
	const [key, values] = parsed as [string, unknown[]];
	if (expectedKey !== undefined && key !== expectedKey) {
		throw new InvalidCursorError(
			`Invalid cursor${at}: it was written for the ordering ` +
				`${key}, not ${expectedKey}`,
			on,
		);
	}
	return { key, values };
}

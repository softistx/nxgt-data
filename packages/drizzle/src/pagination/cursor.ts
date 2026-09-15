import { InvalidCursorError } from '../errors/data-error';

/** What a cursor holds: the values of the ordering columns of the last row. */
export interface CursorPayload {
	/** The ordering it was written for: `<column>:<asc|desc>`. */
	readonly key: string;
	readonly values: readonly unknown[];
}

// JSON has no Date and no bigint, and a cursor must give back the very value
// it was written from: a Date compared with a timestamp column, a bigint with
// a bigint column.
function replacer(this: Record<string, unknown>, key: string, value: unknown) {
	const raw = this[key];
	if (raw instanceof Date) return { $date: raw.toISOString() };
	if (typeof raw === 'bigint') return { $bigint: raw.toString() };
	return value;
}

function reviver(_key: string, value: unknown): unknown {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const keys = Object.keys(value);
		if (keys.length === 1) {
			const tagged = value as { $date?: unknown; $bigint?: unknown };
			if (typeof tagged.$date === 'string') return new Date(tagged.$date);
			if (typeof tagged.$bigint === 'string') return BigInt(tagged.$bigint);
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
 * Writes an opaque, URL-safe cursor. `Date` and `bigint` values survive the
 * round trip. It is encoded, not signed: a client can read it, and forge one.
 */
export function encodeCursor(payload: CursorPayload): string {
	return toBase64Url(JSON.stringify([payload.key, payload.values], replacer));
}

/**
 * Reads a cursor `encodeCursor` wrote. Throws `InvalidCursorError` for
 * anything else, and for a cursor written for another ordering when
 * `expectedKey` is given.
 */
export function decodeCursor(
	cursor: string,
	expectedKey?: string,
): CursorPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fromBase64Url(cursor), reviver);
	} catch (cause) {
		throw new InvalidCursorError('Invalid cursor: it cannot be decoded', {
			cause,
		});
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 2 ||
		typeof parsed[0] !== 'string' ||
		!Array.isArray(parsed[1])
	) {
		throw new InvalidCursorError('Invalid cursor: unexpected shape');
	}
	const [key, values] = parsed as [string, unknown[]];
	if (expectedKey !== undefined && key !== expectedKey) {
		throw new InvalidCursorError(
			`Invalid cursor: it was written for the ordering ${key}, not ${expectedKey}`,
		);
	}
	return { key, values };
}

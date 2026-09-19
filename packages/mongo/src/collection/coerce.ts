import { ObjectId } from 'mongodb';
import type { z } from 'zod';
import type { CollectionContext } from './context';
import type { Fields } from './filters';

/**
 * What a value is on the wire, when its stored form is not a JSON one.
 *
 * Only two: an `ObjectId` and a `Date` are the fields whose **string form is
 * the transport form** — a path parameter, a query string, a JSON body all
 * carry them as text, and there is exactly one reading of that text. A
 * number or a boolean is not here on purpose: `'5'` and `'false'` are
 * ambiguous enough that coercing them hides mistakes rather than fixing one.
 */
export type BsonKind = 'objectId' | 'date';

/** Every field whose value is coerced, by path — `author.id` included. */
export type FieldKinds = Readonly<Record<string, BsonKind>>;

/**
 * A stored type as it may be **given**: the type side of the coercion above.
 *
 * Wherever the collection converts a string at runtime — a filter, a create,
 * a patch — the type has to accept that string, or the conversion is code
 * nobody can reach. So an `ObjectId` field also takes a string here, a `Date`
 * field also takes a string, and every other field is left exactly as the
 * schema types it: this widens two types and nothing else.
 *
 * It follows the value into arrays and into nested objects, which is where
 * `kindsOf` builds its dotted paths, and it distributes over a union, so a
 * `ObjectId | null` field takes `ObjectId | string | null`.
 */
export type AsGiven<T> = T extends ObjectId
	? ObjectId | string
	: T extends Date
		? Date | string
		: T extends readonly (infer E)[]
			? T extends E[]
				? AsGiven<E>[]
				: readonly AsGiven<E>[]
			: // A function is not a document field, and mapping over one would
				// lose its call signature.
				T extends (...args: never[]) => unknown
				? T
				: T extends object
					? { [K in keyof T]: AsGiven<T[K]> }
					: T;

interface Def {
	readonly type: string;
	readonly innerType?: z.ZodType;
	readonly element?: z.ZodType;
	readonly shape?: Record<string, z.ZodType>;
}

function defOf(schema: z.ZodType): Def {
	return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/**
 * The schema under its wrappers.
 *
 * Measured on zod 4.6.5: `.meta()` does **not** travel through `optional`,
 * `nullable`, `default`, `catch` or `readonly` — `objectId().optional().meta()`
 * is `null` — so the metadata `objectId()` carries is only readable once the
 * wrappers are off.
 */
function unwrap(schema: z.ZodType): z.ZodType {
	let current = schema;
	for (;;) {
		const def = defOf(current);
		if (def.innerType === undefined) return current;
		current = def.innerType;
	}
}

/**
 * What this field holds, or `undefined` when nothing is coerced into it.
 *
 * An array collapses to its element's kind, so one rule covers both a field
 * that holds a list of ids and an `$in` over a field that holds one.
 */
export function bsonKindOf(schema: z.ZodType): BsonKind | undefined {
	const inner = unwrap(schema);
	const def = defOf(inner);
	if (def.type === 'array' && def.element) return bsonKindOf(def.element);
	// `objectId()` declares it, and so may any schema:
	// `.meta({ bsonType: 'objectId' })`. It is the same signal the validator
	// is built from, so a field cannot be one thing to MongoDB and another here.
	if (inner.meta()?.bsonType === 'objectId') return 'objectId';
	if (def.type === 'date') return 'date';
	return undefined;
}

/**
 * Every coercible field of a shape, by the path a filter would spell.
 *
 * Nested objects are walked, so `{ author: z.object({ id: objectId() }) }`
 * gives `author.id` — which is how a filter names it.
 */
export function kindsOf(shape: Record<string, z.ZodType>): FieldKinds {
	const kinds: Record<string, BsonKind> = {};
	const walk = (fields: Record<string, z.ZodType>, prefix: string) => {
		for (const [name, schema] of Object.entries(fields)) {
			const path = prefix ? `${prefix}.${name}` : name;
			const kind = bsonKindOf(schema);
			if (kind) {
				kinds[path] = kind;
				continue;
			}
			const def = defOf(unwrap(schema));
			const nested =
				def.shape ??
				(def.element ? defOf(unwrap(def.element)).shape : undefined);
			// Depth is bounded by the schema, which is finite and written by
			// hand; a cycle would need a `z.lazy`, which has no `shape`.
			if (nested) walk(nested, path);
		}
	};
	walk(shape, '');
	return kinds;
}

/**
 * A plain object, and not an instance of anything.
 *
 * `isRecord` is not enough here, and the difference is not academic: an
 * `ObjectId` **is** a non-array object, so a filter value of one read as a
 * bag of operators gets walked with `Object.entries` and comes back as
 * `{ i0, i1, … }` — a lookup by id that worked, turned into a filter that
 * matches nothing. A `Date`, a `Decimal128` and a `Binary` are the same
 * shape of mistake. Only what a caller wrote as a literal is walked into.
 */
function isPlain(value: unknown): value is Fields {
	// Spelled out rather than taken from `filters.ts`, which imports this
	// module: a value edge back would be the one cycle in `collection/`.
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * The 24-character hex string, and nothing else, is an `ObjectId`.
 *
 * Written out rather than left to `ObjectId.isValid`, which on mongodb 7.6
 * agrees with it for strings — measured — but has not always: it used to
 * take any 12-character string, which would turn a slug into an id. This
 * does not move when the driver does.
 */
const HEX_24 = /^[0-9a-fA-F]{24}$/;

/**
 * A date, written the one way that means the same thing everywhere.
 *
 * Written out for the same reason as `HEX_24`, and with more cause: `new Date`
 * is a parser of last resort, and every one of these is a guess it makes
 * happily — measured on bun 1.4.2, in `America/Toronto`.
 *
 * - `'5'` → 2001-05-01, in the **server's** zone.
 * - `'2026'` → the first of January.
 * - `'2026-01-01T00:00'`, with no zone → 05:00Z here, 23:00Z the day before
 *   in Sydney: the same request, two instants.
 * - `'2026-02-31'` → the third of March.
 *
 * So a date is a calendar date, and a time is one with a zone on it. Anything
 * else is handed on for the schema to refuse by name.
 */
const ISO_DATE =
	/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Is that year, month and day a day that exists? Day 0 is the month before's last. */
function isCalendarDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) return false;
	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The value as the field holds it, or the value untouched.
 *
 * It never guesses. A string that is not 24 hex characters is not an id, and
 * a string that is not an unambiguous date is not a date: both are handed on
 * as they came, so the schema refuses them with its own message — a coercion
 * that invented a value would be worse than the refusal it replaced.
 *
 * A number is **not** a date either: epoch seconds and epoch milliseconds
 * read the same and differ by a factor of a thousand.
 */
export function coerceValue(kind: BsonKind, value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((one) => coerceValue(kind, one));
	}
	if (typeof value !== 'string') return value;
	if (kind === 'objectId') {
		return HEX_24.test(value) ? new ObjectId(value) : value;
	}
	const parts = ISO_DATE.exec(value);
	if (!parts) return value;
	if (!isCalendarDate(Number(parts[1]), Number(parts[2]), Number(parts[3]))) {
		return value;
	}
	const date = new Date(value);
	// A time the shape allows and the calendar does not — `T25:00:00Z`.
	return Number.isNaN(date.getTime()) ? value : date;
}

/** The operators whose operand is a value of the field it sits under. */
const VALUE_OPERATORS = new Set([
	'$eq',
	'$ne',
	'$gt',
	'$gte',
	'$lt',
	'$lte',
	'$in',
	'$nin',
	'$all',
	// `$push: { tags: { $each: [...] } }`: an array of the field's own values.
	'$each',
]);

/** The operators that carry filters of their own rather than values. */
const FILTER_OPERATORS = new Set(['$and', '$or', '$nor']);

/**
 * A filter with its string ids and dates turned into what the collection
 * stores, so `find({ _id: '507f…' })` matches the document it names.
 *
 * Without it that filter is not an error: it matches **nothing**, silently,
 * which is the failure this exists to remove.
 *
 * What it leaves alone is as deliberate as what it touches: `$exists`,
 * `$type`, `$size`, `$regex` and `$mod` take operands that are not values of
 * their field, and a field the schema does not declare is never guessed at.
 */
export function coerceFilter(kinds: FieldKinds, filter: Fields): Fields {
	const out: Fields = {};
	for (const [key, value] of Object.entries(filter)) {
		if (FILTER_OPERATORS.has(key) && Array.isArray(value)) {
			out[key] = value.map((one) =>
				isPlain(one) ? coerceFilter(kinds, one) : one,
			);
			continue;
		}
		if (key === '$not' && isPlain(value)) {
			out[key] = coerceFilter(kinds, value);
			continue;
		}
		const kind = kinds[key];
		if (!kind) {
			// An array of documents has no kind of its own, but its elements'
			// fields do: `{ authors: { $elemMatch: { id: '507f…' } } }` is the
			// same filter as `{ 'authors.id': '507f…' }` and must read the same.
			out[key] = isPlain(value) ? elemMatched(kinds, key, value) : value;
			continue;
		}
		out[key] = isPlain(value)
			? coerceOperators(kind, value)
			: coerceValue(kind, value);
	}
	return out;
}

/** `{ $elemMatch: { … } }` under a field, filtered with the kinds inside it. */
function elemMatched(kinds: FieldKinds, path: string, value: Fields): Fields {
	const inner = value.$elemMatch;
	if (!isPlain(inner)) return value;
	const under = kindsUnder(kinds, path);
	return under ? { ...value, $elemMatch: coerceFilter(under, inner) } : value;
}

/** `{ $in: [...] }`, `{ $gte: '2026-01-01' }` and the rest, under one field. */
function coerceOperators(kind: BsonKind, operators: Fields): Fields {
	const out: Fields = {};
	for (const [operator, operand] of Object.entries(operators)) {
		out[operator] =
			operator === '$not' && isPlain(operand)
				? coerceOperators(kind, operand)
				: VALUE_OPERATORS.has(operator)
					? coerceValue(kind, operand)
					: operand;
	}
	return out;
}

/**
 * A document or a patch, field by field. Operator patches (`$set`, `$push`
 * and the rest) are walked into, because that is where the values are.
 */
export function coerceFields(kinds: FieldKinds, values: Fields): Fields {
	const out: Fields = {};
	for (const [key, value] of Object.entries(values)) {
		if (key.startsWith('$') && isPlain(value)) {
			out[key] = coerceFields(kinds, value);
			continue;
		}
		const kind = kinds[key];
		if (!kind) {
			out[key] = coerceNested(kinds, key, value);
			continue;
		}
		// An `ObjectId` and a `Date` are not plain, so a plain value on a
		// field that holds one is an operator bag: `$each`, `$in`, `$gte`.
		out[key] = isPlain(value)
			? coerceOperators(kind, value)
			: coerceValue(kind, value);
	}
	return out;
}

/** A field holding an object, whose own fields may be coercible. */
function coerceNested(
	kinds: FieldKinds,
	path: string,
	value: unknown,
): unknown {
	if (Array.isArray(value)) {
		return value.map((one) => coerceNested(kinds, path, one));
	}
	if (!isPlain(value)) return value;
	const under = kindsUnder(kinds, path);
	return under ? coerceFields(under, value) : value;
}

/**
 * The kinds of the fields under a path, renamed relative to it — what a
 * sub-document and an `$elemMatch` are filtered and written with. `undefined`
 * when there are none, so a caller can leave the value untouched.
 */
function kindsUnder(kinds: FieldKinds, path: string): FieldKinds | undefined {
	const under: Record<string, BsonKind> = {};
	const prefix = `${path}.`;
	for (const [key, kind] of Object.entries(kinds)) {
		if (key.startsWith(prefix)) under[key.slice(prefix.length)] = kind;
	}
	return Object.keys(under).length > 0 ? under : undefined;
}

/**
 * A document or a patch a caller wrote, read before anything else sees it.
 *
 * `toDocument` and `toUpdate` do this again on their way to the server; this
 * is for the hooks, which run first and are typed on the **stored** forms.
 * Both are idempotent, so running twice costs a walk and changes nothing.
 */
export function coercedValues(
	ctx: CollectionContext,
	values: unknown,
): unknown {
	return ctx.coerces && isPlain(values)
		? coerceFields(ctx.kinds, values)
		: values;
}

/**
 * An `_id` as the collection stores it.
 *
 * The id-taking methods build their filter by hand — `{ _id: id }` merged
 * with the soft-delete scope, the expected version, or nothing — rather than
 * passing through `scoped`, so this is applied to the **argument** at each
 * entry point. It is idempotent: an id that is already an `ObjectId` comes
 * back as it was.
 */
export function coerceId(ctx: CollectionContext, id: unknown): unknown {
	const kind = ctx.kinds._id;
	return ctx.coerces && kind ? coerceValue(kind, id) : id;
}

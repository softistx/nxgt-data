import type { Document } from 'mongodb';
import { isObjectId } from '../../definition/object-id';
import { coercedValues } from '../coerce';
import { type CollectionContext, run } from '../context';
import { setFromFields, withId, withoutUndefined } from '../documents';
import { coerced, type Fields, isRecord, live, mergeFilters } from '../filters';
import { keptByCollection, refuseFixed } from '../stamp-writes';

/**
 * A value written as itself, and not as an expression.
 *
 * Every stage below is an **aggregation** pipeline stage, where a string is a
 * field path: measured on mongod 8.2, `$set: { title: '$100 off' }` writes no
 * `title` at all — the field is silently dropped, because `$100` reads as a
 * path into a document that has no such field. So nothing a caller wrote
 * reaches a stage unwrapped.
 *
 * `$literal` carries BSON through untouched: an `ObjectId` comes back an
 * `ObjectId` and a `Date` a `Date` — also measured.
 */
function literal(value: unknown): Document {
	return { $literal: value };
}

/**
 * The field's stored value, or `fallback` when the document does not have
 * the field at all.
 *
 * `$ifNull` is the short way to write this and the wrong one: it cannot tell
 * a field that is missing from one stored as `null`, so a field whose schema
 * default is not `null` would be quietly reset on every upsert that matched.
 * `$type` tells them apart — measured: a stored `null` comes back `null`,
 * and `$set` of a path that is missing leaves the field unset rather than
 * writing it as `null`.
 */
function unlessStored(field: string, fallback: Document | unknown): Document {
	return {
		$cond: [
			{ $eq: [{ $type: `$${field}` }, 'missing'] },
			fallback,
			`$${field}`,
		],
	};
}

/**
 * How the stage asks whether it is **inserting**, when it can ask at all.
 *
 * The server seeds an inserted document from the filter before the pipeline
 * runs, so `$_id` is there when — and only when — the filter named it.
 * Measured: `$type` of `$_id` is `missing` on an insert whose filter did not
 * name it, and `objectId` on the update that follows. `seedsOf` refuses the
 * `$and`/`$or` that could hide an `_id`, so the seeds are the whole filter
 * and this is sound whenever they carry none.
 *
 * With the signal, the update half writes only what it was asked to write.
 * Without it — a collection keyed by a string `_id`, which has to name it in
 * the filter — each field falls back to its own absence, which is the
 * closest true thing and the one place an upsert writes more than `update`.
 */
function insertingWhen(seeds: Fields): Document | undefined {
	if (seeds._id !== undefined) return undefined;
	return { $eq: [{ $type: '$_id' }, 'missing'] };
}

/** `value` on the insert, and the stored field untouched on the update. */
function onInsert(
	inserting: Document | undefined,
	field: string,
	value: Document | unknown,
): Document {
	if (!inserting) return unlessStored(field, value);
	return { $cond: [inserting, value, `$${field}`] };
}

/**
 * The fields whose schema default an upsert fills in when the document does
 * not carry them.
 *
 * `create` fills every default by parsing the document, and fills the stamps
 * alone when it is asked not to parse (`fillStamps`). An upsert never holds a
 * document, so it says the same thing field by field — and over the same
 * fields, or an insert would land more than a create lands.
 */
function filledBy(ctx: CollectionContext): string[] {
	if (ctx.parses) return Object.keys(ctx.shape);
	return Object.values(ctx.stamps).filter((name): name is string => !!name);
}

/**
 * What an upsert sets, as one `$set` stage.
 *
 * It has to be a pipeline rather than `$set`/`$setOnInsert`, because the two
 * cannot both touch the version: measured on mongod 8.2, `$inc: { version: 1 }`
 * beside `$setOnInsert: { version: 0 }` is refused — "would create a conflict
 * at 'version'" — and `$inc` alone starts an inserted document at **1**, one
 * ahead of what `create` gives. A pipeline can branch, so an insert reads the
 * same as a create and an update raises the version as `update` does.
 *
 * Every branch asks whether **that field** is there, never whether this is an
 * insert: the server seeds an inserted document from the filter, so `_id`
 * itself can be there before the stage runs, and a stored document can be
 * missing a field the schema has gained since. Asking field by field is right
 * in both cases.
 *
 * Every expression here sees the document as it was **before** the stage, so
 * `$createdAt` is the stored one and not one this stage just wrote.
 */
function upsertStage(
	ctx: CollectionContext,
	values: Fields,
	wrote: ReadonlySet<string>,
	inserting: Document | undefined,
): Document {
	const set: Document = {};
	for (const [field, value] of Object.entries(values)) {
		set[field] = literal(value);
	}

	// A field the schema fills on its own is filled here too, so that an
	// insert lands the document `create` would have landed.
	for (const field of filledBy(ctx)) {
		// `_id` is the server's on an insert and cannot be written on an
		// update; `id` is computed and stored nowhere.
		if (field === '_id' || field === 'id' || field in set) continue;
		const filled = ctx.shape[field]?.safeParse(undefined);
		if (!filled?.success || filled.data === undefined) continue;
		set[field] = onInsert(inserting, field, literal(filled.data));
	}

	const { updatedAt, createdBy, updatedBy, version } = ctx.stamps;
	// `createdAt` needs no branch of its own: the loop above already writes it
	// on the insert and leaves the stored one alone on the update.
	const now = new Date();
	// A stamp the caller wrote itself is left to them, as `update` leaves it.
	if (ctx.touches && updatedAt && !wrote.has(updatedAt)) {
		set[updatedAt] = literal(now);
	}
	if (ctx.actor !== undefined && createdBy) {
		// Who created it, not who is upserting it: with the signal above, a
		// document that has no `createdBy` keeps none rather than being
		// credited to whoever happened to match it.
		set[createdBy] = onInsert(inserting, createdBy, literal(ctx.actor));
	}
	if (ctx.actor !== undefined && updatedBy) set[updatedBy] = literal(ctx.actor);
	if (ctx.locks && version) {
		// A document with no version starts at 0, exactly as a create does —
		// `$add` over a missing field would be `null`, and every later lock on
		// that document would fail on a non-numeric version.
		set[version] = {
			$cond: [
				{ $eq: [{ $type: `$${version}` }, 'missing'] },
				0,
				{ $add: [{ $ifNull: [`$${version}`, 0] }, 1] },
			],
		};
	}
	return { $set: set };
}

/** What an upsert gives back, and which half of it ran. */
export interface Upserted {
	document: Fields;
	inserted: boolean;
}

/**
 * The document that matches, changed — or a new one, in one round trip.
 *
 * The filter is scoped to the live documents, as every other write is, and
 * its fields seed the document an insert creates: measured,
 * `upsert({ email }, …)` puts `email` on the new document. `seedsOf` is what
 * makes that seeding knowable — see there.
 */
export async function upsert(
	ctx: CollectionContext,
	filter: unknown,
	values: unknown,
): Promise<Upserted> {
	if (!isRecord(values)) {
		throw new TypeError(
			`upsert: expected the document's fields, not ${String(values)}`,
		);
	}
	const given = coerced(ctx, filter);
	const seeds = seedsOf(ctx, given);
	// A field given as `undefined` says nothing, and it must not count as
	// written either: it would suppress the `updatedAt` touch below and
	// freeze the stamp. `toUpdate` drops them for the same reason.
	const asked = withoutUndefined(coercedValues(ctx, values) as Fields);
	const wrote = refuseFixed(ctx, 'upsert', asked);
	const written = setFromFields(ctx, asked, 'upsert');
	// An upsert has to be able to **insert**, so what the filter seeds, what
	// this writes and the schema's own defaults must together be a document
	// the schema accepts. `create` gets that from parsing the whole document;
	// a pipeline cannot, since it never holds one. Without this, a missing
	// required field is a `ValidationError` from the server on the day the
	// document happens not to exist — or, under `validate: 'off'`, a stored
	// document with a hole in it. It throws where `create` throws, and names
	// the same field. It is also why a required field with no default has to
	// be named on **every** upsert, matching or not: the check cannot know
	// which half will run, and an upsert that could not insert is an update.
	if (ctx.parses) ctx.definition.schema.parse({ ...seeds, ...written });
	const scoped = mergeFilters(given, live(ctx));
	const answer = await run(ctx, async () =>
		ctx.collection.findOneAndUpdate(
			scoped,
			[upsertStage(ctx, written, wrote, insertingWhen(seeds))],
			{
				...ctx.sessionOption,
				upsert: true,
				returnDocument: 'after',
				includeResultMetadata: true,
			},
		),
	);
	const document = answer.value as Fields | null;
	if (!document) {
		// The server answered no document for an upsert, which it does not do.
		throw new TypeError(`upsert: "${ctx.name}" wrote nothing`);
	}
	return {
		document: withId(ctx, document),
		inserted: answer.lastErrorObject?.upserted !== undefined,
	};
}

function refuse(ctx: CollectionContext, reason: string): never {
	throw new TypeError(`upsert: "${ctx.name}" ${reason}`);
}

/**
 * The fields an insert would be seeded with, refusing every filter whose
 * seeding this package cannot state.
 *
 * The server seeds an inserted document from the filter's **equality**
 * conditions — measured, and from the ones inside `$and` and `$or` as well,
 * which is why those are refused here: a filter that says "gold or silver"
 * cannot say which tier the document it inserts would have. Everything left
 * is a plain field with a plain value, and that is the whole seed.
 */
function seedsOf(ctx: CollectionContext, filter: Fields): Fields {
	const seeds: Fields = {};
	const kept = new Set(keptByCollection(ctx));
	for (const [field, value] of Object.entries(filter)) {
		if (field.startsWith('$')) {
			refuse(
				ctx,
				`cannot upsert through "${field}": the server seeds an inserted ` +
					'document from the conditions inside it too, and a filter that ' +
					'offers a choice cannot say what it would insert. Filter by ' +
					'plain values, or write the insert and the update yourself.',
			);
		}
		if (field.includes('.')) {
			refuse(
				ctx,
				`cannot upsert through the path "${field}": an upsert's filter ` +
					'names a field and the whole value it would insert, not a part ' +
					'of one.',
			);
		}
		if (!ctx.shape[field]) {
			refuse(ctx, `has no field "${field}" in its schema`);
		}
		if (kept.has(field)) {
			refuse(
				ctx,
				`cannot be filtered on "${field}" in an upsert: the filter is ` +
					'written into the document an insert creates, and this ' +
					'collection keeps that field itself.',
			);
		}
		if (seedsNothing(value)) {
			refuse(
				ctx,
				`cannot upsert on "${field}": it is matched rather than given a ` +
					'value, and a condition seeds nothing into an inserted ' +
					'document. Give it a value, or write the insert and the update ' +
					'yourself.',
			);
		}
		seeds[field] = value;
	}
	// `_id` is the one default an upsert cannot apply: measured, the server
	// seeds `_id` before the pipeline runs, so `$type` of `$_id` is never
	// `missing` and no branch can write the schema's own. Where that default
	// is not an `ObjectId`, an insert would land the server's id instead of
	// the one `create` writes — so the filter has to carry it.
	if (ctx.parses && seeds._id === undefined) {
		const filled = ctx.shape._id?.safeParse(undefined);
		if (
			filled?.success &&
			filled.data !== undefined &&
			!isObjectId(filled.data)
		) {
			refuse(
				ctx,
				'needs "_id" in its filter: its schema fills `_id` with a value ' +
					'the server cannot generate, and an insert would land the ' +
					"server's `ObjectId` in its place.",
			);
		}
	}
	if (Object.keys(seeds).length === 0) {
		refuse(
			ctx,
			'needs a filter naming at least one field by value, so that an ' +
				'inserted document carries it.',
		);
	}
	return seeds;
}

/**
 * A condition rather than a value: `{ $gt: 5 }`, or a regular expression,
 * which matches a shape and so seeds nothing — measured, an upsert filtered
 * by one inserts a document without the field at all.
 */
function seedsNothing(value: unknown): boolean {
	if (value instanceof RegExp) return true;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).some((key) => key.startsWith('$'));
}

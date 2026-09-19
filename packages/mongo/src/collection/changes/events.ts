import type { ChangeStreamOptions, Document } from 'mongodb';
import type { CollectionContext } from '../context';
import { withId } from '../documents';
import { coerced, type Fields } from '../filters';
import type { ChangeOptions, ChangeType } from './types';

const ALL: readonly ChangeType[] = ['create', 'update', 'delete', 'restore'];

/**
 * The server's operations each change can come from. A soft delete and a
 * restore are updates on the server, and are told apart once they arrive.
 */
const OPERATIONS: Record<ChangeType, readonly string[]> = {
	create: ['insert'],
	update: ['update', 'replace'],
	delete: ['delete', 'update'],
	restore: ['update'],
};

/** Whether the collection keeps pre- and post-images for its change streams. */
function keepsImages(ctx: CollectionContext): boolean {
	return ctx.definition.options.changeStreamPreAndPostImages?.enabled === true;
}

/**
 * A filter on the documents, as a filter on the change events: each field is
 * looked up under `prefix`. Only field conditions and the three logical
 * operators have a meaning there — `$expr`, `$text` or `$where` would be read
 * against the event, not the document, so they are refused rather than
 * quietly matching the wrong thing.
 */
function prefixed(filter: Fields, prefix: string): Fields {
	const out: Fields = {};
	for (const [key, value] of Object.entries(filter)) {
		if (key === '$and' || key === '$or' || key === '$nor') {
			out[key] = (value as Fields[]).map((inner) => prefixed(inner, prefix));
		} else if (key.startsWith('$')) {
			throw new TypeError(
				`onChange: a filter cannot use ${key}. Use conditions on fields, ` +
					'combined with $and, $or or $nor.',
			);
		} else {
			out[`${prefix}.${key}`] = value;
		}
	}
	return out;
}

/** What the server is asked to send, built once per subscription. */
export function pipelineOf(
	ctx: CollectionContext,
	options: ChangeOptions<never>,
): Document[] {
	const events = options.events ?? ALL;
	const operations = [...new Set(events.flatMap((e) => OPERATIONS[e]))];
	const stages: Document[] = [
		{ $match: { operationType: { $in: [...operations, 'invalidate'] } } },
	];
	// Coerced like every other filter: a subscription keyed on a string id
	// would otherwise match nothing, and nothing is what a change stream
	// delivers anyway, so the mistake would never surface.
	const filter: Fields = coerced(ctx, options.filter);
	if (Object.keys(filter).length > 0) {
		stages.push({
			$match: {
				$or: [
					prefixed(filter, 'fullDocument'),
					{
						operationType: 'delete',
						// A hard delete is matched on the document it removed when the
						// event carries one, and let through when it does not: decided
						// by what the server sent, not by what the definition says,
						// since a collection may not be synced yet.
						$or: [
							{ fullDocumentBeforeChange: null },
							prefixed(filter, 'fullDocumentBeforeChange'),
						],
					},
					{ operationType: 'invalidate' },
				],
			},
		});
	}
	return stages;
}

/** The driver's options: the exact images when there are any, a lookup when not. */
export function watchOptionsOf(
	ctx: CollectionContext,
	startAfter: unknown,
): ChangeStreamOptions {
	return {
		fullDocument: keepsImages(ctx) ? 'whenAvailable' : 'updateLookup',
		// Asked for always: a collection without pre-images answers with none,
		// and does not refuse — measured.
		fullDocumentBeforeChange: 'whenAvailable',
		...(startAfter === undefined ? {} : { startAfter: startAfter as never }),
	};
}

const documentOf = (ctx: CollectionContext, value: unknown) =>
	value ? withId(ctx, value as Fields) : undefined;

const isSet = (value: unknown) => value !== null && value !== undefined;

/**
 * What an update or a replacement is, once a soft delete and a restore are
 * told apart from other writes.
 *
 * With a pre-image, the soft-delete field before and after is compared, so
 * stamping an already-deleted document again is an update. Without one, the
 * event is all there is: an update that sets the field is a delete, one that
 * clears or removes it a restore, and a replacement that leaves the document
 * deleted a delete — a replacement cannot be seen to restore.
 */
function writeTypeOf(
	ctx: CollectionContext,
	event: Fields,
	document: Fields | undefined,
	before: Fields | undefined,
): ChangeType {
	const field = ctx.softDeletes ? ctx.stamps.deletedAt : false;
	if (!field) return 'update';
	let deletedNow: boolean | undefined;
	if (event.operationType === 'replace') {
		deletedNow = document ? isSet(document[field]) : undefined;
	} else {
		const description = event.updateDescription as
			| { updatedFields?: Fields; removedFields?: string[] }
			| undefined;
		const set = description?.updatedFields ?? {};
		if (field in set) deletedNow = isSet(set[field]);
		else if (description?.removedFields?.includes(field)) deletedNow = false;
	}
	if (deletedNow === undefined) return 'update';
	if (before) {
		if (isSet(before[field]) === deletedNow) return 'update';
		return deletedNow ? 'delete' : 'restore';
	}
	if (event.operationType === 'replace')
		return deletedNow ? 'delete' : 'update';
	return deletedNow ? 'delete' : 'restore';
}

/**
 * A server event as this package's change, or `undefined` for one the
 * subscription does not deliver: an operation it does not describe, a type
 * it was not asked for, or an update to a soft-deleted document.
 */
export function toChange(
	ctx: CollectionContext,
	event: Fields,
	options: ChangeOptions<never>,
): Fields | undefined {
	const operation = event.operationType;
	const document = documentOf(ctx, event.fullDocument);
	const before = documentOf(ctx, event.fullDocumentBeforeChange);
	const type: ChangeType | undefined =
		operation === 'insert'
			? 'create'
			: operation === 'delete'
				? 'delete'
				: operation === 'update' || operation === 'replace'
					? writeTypeOf(ctx, event, document, before)
					: undefined;
	if (!type || !(options.events ?? ALL).includes(type)) return undefined;

	const field = ctx.softDeletes ? ctx.stamps.deletedAt : false;
	if (
		type === 'update' &&
		field &&
		!options.withDeleted &&
		isSet(document?.[field])
	) {
		return undefined;
	}

	const description = event.updateDescription as
		| { updatedFields: Fields; removedFields: string[] }
		| undefined;
	return {
		type,
		id: (event.documentKey as Fields)._id,
		at: (event.wallTime as Date | undefined) ?? new Date(),
		resumeToken: event._id,
		document,
		before,
		...(type === 'delete' ? { hard: operation === 'delete' } : {}),
		...(type === 'update'
			? {
					fields: description && {
						set: description.updatedFields,
						removed: description.removedFields,
					},
				}
			: {}),
	};
}

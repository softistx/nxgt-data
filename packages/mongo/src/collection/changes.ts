import type { ChangeStreamOptions, Document } from 'mongodb';
import type { ChangeOptions, ChangeType } from './change-types';
import type { CollectionContext } from './context';
import { withId } from './documents';
import type { Fields } from './filters';

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
	const filter = options.filter as Fields | undefined;
	if (filter && Object.keys(filter).length > 0) {
		stages.push({
			$match: {
				$or: [
					prefixed(filter, 'fullDocument'),
					{
						operationType: 'delete',
						// Without pre-images a hard delete carries no document: it
						// cannot be matched, so it is let through.
						...(keepsImages(ctx)
							? prefixed(filter, 'fullDocumentBeforeChange')
							: {}),
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
	const images = keepsImages(ctx);
	return {
		fullDocument: images ? 'whenAvailable' : 'updateLookup',
		fullDocumentBeforeChange: images ? 'whenAvailable' : 'off',
		...(startAfter === undefined ? {} : { startAfter: startAfter as never }),
	};
}

const documentOf = (ctx: CollectionContext, value: unknown) =>
	value ? withId(ctx, value as Fields) : undefined;

/** What an update event is, once a soft delete and a restore are told apart. */
function updateTypeOf(
	ctx: CollectionContext,
	event: Fields,
): ChangeType | undefined {
	const field = ctx.softDeletes ? ctx.stamps.deletedAt : false;
	if (!field) return 'update';
	const description = event.updateDescription as
		| { updatedFields?: Fields; removedFields?: string[] }
		| undefined;
	const set = description?.updatedFields ?? {};
	if (field in set) return set[field] === null ? 'restore' : 'delete';
	if (description?.removedFields?.includes(field)) return 'restore';
	return 'update';
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
	const type =
		operation === 'insert'
			? 'create'
			: operation === 'delete'
				? 'delete'
				: operation === 'replace'
					? 'update'
					: operation === 'update'
						? updateTypeOf(ctx, event)
						: undefined;
	if (!type || !(options.events ?? ALL).includes(type)) return undefined;

	const document = documentOf(ctx, event.fullDocument);
	const field = ctx.softDeletes ? ctx.stamps.deletedAt : false;
	if (
		type === 'update' &&
		field &&
		!options.withDeleted &&
		document &&
		document[field] !== null &&
		document[field] !== undefined
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
		before: documentOf(ctx, event.fullDocumentBeforeChange),
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

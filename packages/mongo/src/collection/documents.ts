import type { CollectionContext } from './context';
import { type Fields, isRecord, isUpdateFilter } from './filters';

/**
 * `id` on a document a collection gives back: `_id` as a string, computed
 * rather than stored — the collection holds `_id` alone.
 *
 * It is enumerable, so `JSON.stringify` and a spread carry it and a handler
 * can return the document as it is. `toDocument` drops it again on a write,
 * and it is no part of `DocumentOf`, so nothing can filter on it: the server
 * would match nothing.
 */
export function withId<T>(ctx: CollectionContext, document: T): T {
	if (
		ctx.hasOwnId ||
		!isRecord(document) ||
		document._id === undefined ||
		Object.hasOwn(document, 'id')
	) {
		return document;
	}
	Object.defineProperty(document, 'id', {
		get: () => String((document as Fields)._id),
		enumerable: true,
		configurable: true,
	});
	return document;
}

/** The document to insert: checked against the schema, defaults filled. */
export function toDocument(ctx: CollectionContext, values: unknown): Fields {
	const stamped: Fields = { ...(values as Fields) };
	// A document that was read carries `id`, which is this collection's view
	// of `_id` and not a field: writing it back would be refused by the
	// validator, which allows no property the schema does not declare.
	// Parsing strips it too, but `validate: 'off'` does not parse.
	if (!ctx.hasOwnId) delete stamped.id;
	if (ctx.actor !== undefined) {
		const { createdBy, updatedBy } = ctx.stamps;
		if (createdBy && stamped[createdBy] === undefined) {
			stamped[createdBy] = ctx.actor;
		}
		if (updatedBy && stamped[updatedBy] === undefined) {
			stamped[updatedBy] = ctx.actor;
		}
	}
	return ctx.parses
		? (ctx.definition.schema.parse(stamped) as Fields)
		: stamped;
}

/** The fields of a patch, checked one by one against the schema. */
function setFromFields(ctx: CollectionContext, patch: Fields): Fields {
	const set: Fields = {};
	for (const [field, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const schema = ctx.shape[field];
		if (!schema) {
			throw new TypeError(
				`update: "${ctx.name}" has no field "${field}" in its schema`,
			);
		}
		set[field] = ctx.parses ? schema.parse(value) : value;
	}
	return set;
}

/**
 * The update to send: a patch of fields becomes `$set`, checked field by
 * field against the schema, with the stamps this collection keeps. A patch
 * that already speaks in operators is sent as it is, with the stamps added.
 */
export function toUpdate(ctx: CollectionContext, patch: unknown): Fields {
	if (!isRecord(patch)) {
		throw new TypeError(
			`update: expected the document's fields or MongoDB's operators, not ${String(patch)}`,
		);
	}
	const operators = isUpdateFilter(patch);
	const update: Fields = operators ? { ...patch } : {};
	const set: Fields = {
		...(isRecord(update.$set) ? update.$set : {}),
		...(operators ? {} : setFromFields(ctx, patch)),
	};

	const { updatedAt, updatedBy, version } = ctx.stamps;
	if (ctx.touches && updatedAt && set[updatedAt] === undefined) {
		set[updatedAt] = new Date();
	}
	if (ctx.actor !== undefined && updatedBy && set[updatedBy] === undefined) {
		set[updatedBy] = ctx.actor;
	}
	if (Object.keys(set).length > 0) update.$set = set;

	if (ctx.locks && version) {
		const inc = isRecord(update.$inc) ? { ...update.$inc } : {};
		inc[version] = (inc[version] as number | undefined) ?? 1;
		update.$inc = inc;
	}
	return update;
}

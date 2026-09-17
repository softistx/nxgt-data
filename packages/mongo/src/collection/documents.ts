import type { CollectionContext } from './context';
import { type Fields, isRecord, isUpdateFilter } from './filters';
import {
	expectedVersionOf,
	fillStamps,
	refuseFixed,
	refuseKeptOnCreate,
} from './stamp-writes';

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
	refuseKeptOnCreate(ctx, stamped);
	// A document that was read carries `id`, which is this collection's view
	// of `_id` and not a field: writing it back would be refused by the
	// validator, which allows no property the schema does not declare.
	// Parsing strips it too, but `validate: 'off'` does not parse.
	if (!ctx.hasOwnId) delete stamped.id;
	if (ctx.actor !== undefined) {
		const { createdBy, updatedBy } = ctx.stamps;
		if (createdBy) stamped[createdBy] = ctx.actor;
		if (updatedBy) stamped[updatedBy] = ctx.actor;
	}
	if (ctx.parses) return ctx.definition.schema.parse(stamped) as Fields;
	fillStamps(ctx, stamped);
	return stamped;
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
 * A patch without the values given as `undefined`, at the top and inside each
 * operator: such a value says nothing, and the driver would send it as `null`.
 */
function withoutUndefined(patch: Fields): Fields {
	const defined: Fields = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (!key.startsWith('$') || !isRecord(value)) {
			defined[key] = value;
			continue;
		}
		defined[key] = Object.fromEntries(
			Object.entries(value).filter(([, v]) => v !== undefined),
		);
	}
	return defined;
}

/** An update, and the version it is conditional on. */
export interface PreparedUpdate {
	update: Fields;
	expectedVersion: number | undefined;
}

/**
 * The update to send: a patch of fields becomes `$set`, checked field by
 * field against the schema, with the stamps this collection keeps. A patch
 * that already speaks in operators is sent as it is, with the stamps added.
 * A version in the patch is the one the document must still be at.
 */
export function toUpdate(
	ctx: CollectionContext,
	given: unknown,
	method: 'update' | 'updateMany' = 'update',
): PreparedUpdate {
	if (!isRecord(given)) {
		throw new TypeError(
			`${method}: expected the document's fields or MongoDB's operators, not ${String(given)}`,
		);
	}
	const patch = withoutUndefined(given);
	const expectedVersion = expectedVersionOf(ctx, method, patch);
	const written = refuseFixed(ctx, method, patch);
	const operators = isUpdateFilter(patch);
	const update: Fields = operators ? patch : {};
	const set: Fields = {
		...(isRecord(update.$set) ? update.$set : {}),
		...(operators ? {} : setFromFields(ctx, patch)),
	};

	const { updatedAt, updatedBy, version } = ctx.stamps;
	// A stamp the patch writes itself, `$currentDate` included, is left to
	// it: setting it a second time is a conflict the server refuses.
	if (ctx.touches && updatedAt && !written.has(updatedAt)) {
		set[updatedAt] = new Date();
	}
	if (ctx.actor !== undefined && updatedBy) {
		set[updatedBy] = ctx.actor;
	}
	if (Object.keys(set).length > 0) update.$set = set;

	if (ctx.locks && version) {
		const inc = isRecord(update.$inc) ? { ...update.$inc } : {};
		inc[version] = 1;
		update.$inc = inc;
	}
	return { update, expectedVersion };
}

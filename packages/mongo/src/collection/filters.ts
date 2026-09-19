import { coerceFilter } from './coerce';
import type { CollectionContext } from './context';

/** A document as this package handles one internally: keys it cannot know. */
export type Fields = Record<string, unknown>;

export function isRecord(value: unknown): value is Fields {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Does this patch speak in MongoDB's operators rather than in fields? */
export function isUpdateFilter(patch: Fields): boolean {
	return Object.keys(patch).some((key) => key.startsWith('$'));
}

/** `a` and `b`, without letting one's `$or` swallow the other's. */
export function mergeFilters(
	a: Fields | undefined,
	b: Fields | undefined,
): Fields {
	const left = a && Object.keys(a).length > 0 ? a : undefined;
	const right = b && Object.keys(b).length > 0 ? b : undefined;
	if (!left) return right ?? {};
	if (!right) return left;
	return { $and: [left, right] };
}

/**
 * The filter that leaves soft-deleted documents out, keyed on whatever the
 * collection calls its soft-delete field.
 */
export function live(
	ctx: CollectionContext,
	withDeleted?: boolean,
): Fields | undefined {
	const field = ctx.stamps.deletedAt;
	if (!ctx.softDeletes || withDeleted || !field) return undefined;
	return { [field]: null };
}

/**
 * A caller's filter, with the strings in it read as the fields they are on.
 *
 * Every filter this package sends goes through here — `scoped` is the one
 * that also narrows, and a hard delete, which is scoped to nothing on
 * purpose, still has to be coerced or the same call would convert or not
 * depending on whether the collection soft-deletes.
 */
export function coerced(ctx: CollectionContext, filter: unknown): Fields {
	const given = isRecord(filter) ? filter : {};
	return ctx.coerces ? coerceFilter(ctx.kinds, given) : given;
}

/** A caller's filter, narrowed to the documents this collection shows. */
export function scoped(
	ctx: CollectionContext,
	filter: unknown,
	withDeleted?: boolean,
): Fields {
	const given = isRecord(filter) ? coerced(ctx, filter) : undefined;
	return mergeFilters(given, live(ctx, withDeleted));
}

/** Refuses a call that would otherwise run on the whole collection. */
export function requireFilter(
	ctx: CollectionContext,
	method: string,
	filter: unknown,
): void {
	if (!isRecord(filter) || Object.keys(filter).length === 0) {
		throw new TypeError(
			`${method} needs a filter. Pass \`{ _id: { $exists: true } }\` to target every document of "${ctx.name}".`,
		);
	}
}

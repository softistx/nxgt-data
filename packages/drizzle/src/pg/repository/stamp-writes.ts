import { sql } from 'drizzle-orm';
import type { AnyRow, RepositoryContext } from './context';

/**
 * The patch a write sets, with `updatedAt = now()` added to it.
 *
 * Three things keep it off. An `undefined` value is dropped rather than
 * written, so a patch that is entirely `undefined` sets nothing and the caller
 * gets the row back untouched — raising `updatedAt` there would record a write
 * that did not happen. A patch that sets the stamp itself is left alone. And a
 * column Drizzle stamps through `$onUpdate` is left to Drizzle, which would
 * otherwise write it twice.
 */
export function touched(ctx: RepositoryContext, patch: AnyRow): AnyRow {
	const set: AnyRow = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) set[key] = value;
	}
	const updatedAt = ctx.info.updatedAt;
	if (
		updatedAt &&
		!(updatedAt.key in set) &&
		!updatedAt.column.onUpdateFn &&
		Object.keys(set).length > 0
	) {
		set[updatedAt.key] = sql`now()`;
	}
	return set;
}

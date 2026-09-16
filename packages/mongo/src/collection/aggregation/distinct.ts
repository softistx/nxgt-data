import { type CollectionContext, run } from '../context';
import { scoped } from '../filters';

/**
 * The distinct values of a field, soft-deleted documents left out. An array
 * field gives its elements; the order is the server's.
 */
export function distinct(
	ctx: CollectionContext,
	field: string,
	opts: { filter?: unknown; withDeleted?: boolean } = {},
): Promise<unknown[]> {
	return run(ctx, () =>
		ctx.collection.distinct(field, scoped(ctx, opts.filter, opts.withDeleted), {
			...ctx.sessionOption,
		}),
	);
}

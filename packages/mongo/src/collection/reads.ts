import { type CollectionContext, notFound, run } from './context';
import { withId } from './documents';
import { type Fields, scoped } from './filters';

/** One document, straight from the driver, carrying its computed `id`. */
export function findOne(
	ctx: CollectionContext,
	filter: Fields,
	projection?: unknown,
): Promise<Fields | null> {
	return run(ctx, async () => {
		const found = await ctx.collection.findOne(filter, {
			...ctx.sessionOption,
			...(projection ? { projection } : {}),
		});
		return found === null ? null : withId(ctx, found as Fields);
	});
}

export async function findById(
	ctx: CollectionContext,
	id: unknown,
	opts: { withDeleted?: boolean } = {},
): Promise<Fields | undefined> {
	const found = await findOne(ctx, scoped(ctx, { _id: id }, opts.withDeleted));
	return found ?? undefined;
}

export async function getById(
	ctx: CollectionContext,
	id: unknown,
	opts: { withDeleted?: boolean } = {},
): Promise<Fields> {
	const found = await findById(ctx, id, opts);
	if (!found) throw notFound(ctx, id);
	return found;
}

export async function findMany(
	ctx: CollectionContext,
	opts: Fields = {},
): Promise<Fields[]> {
	return run(ctx, async () => {
		let cursor = ctx.collection.find(
			scoped(ctx, opts.filter, opts.withDeleted as boolean | undefined),
			{
				...ctx.sessionOption,
				...(opts.projection ? { projection: opts.projection } : {}),
			},
		);
		if (opts.sort !== undefined) cursor = cursor.sort(opts.sort as never);
		if (opts.skip !== undefined) cursor = cursor.skip(opts.skip as number);
		if (opts.limit !== undefined) cursor = cursor.limit(opts.limit as number);
		const found = await cursor.toArray();
		return found.map((document) => withId(ctx, document as Fields));
	});
}

export async function findFirst(
	ctx: CollectionContext,
	filter?: unknown,
	opts: Fields = {},
): Promise<Fields | undefined> {
	const [first] = await findMany(ctx, { ...opts, filter, limit: 1 });
	return first;
}

export async function countDocuments(
	ctx: CollectionContext,
	filter?: unknown,
	opts: { withDeleted?: boolean } = {},
): Promise<number> {
	return run(ctx, async () =>
		ctx.collection.countDocuments(scoped(ctx, filter, opts.withDeleted), {
			...ctx.sessionOption,
		}),
	);
}

export async function exists(
	ctx: CollectionContext,
	filter: unknown,
	opts: { withDeleted?: boolean } = {},
): Promise<boolean> {
	const found = await findOne(ctx, scoped(ctx, filter, opts.withDeleted), {
		_id: 1,
	});
	return found !== null && found !== undefined;
}

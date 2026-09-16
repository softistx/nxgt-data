import { type CollectionContext, run } from '../context';
import { type Fields, isRecord, scoped } from '../filters';

const OPERATORS = ['sum', 'avg', 'min', 'max'] as const;
const RESERVED = new Set(['key', 'count', '_id']);

/** One measure as a `$group` accumulator, checked on the way. */
function accumulator(name: string, measure: unknown): Fields {
	if (RESERVED.has(name) || name.startsWith('$') || name.includes('.')) {
		throw new TypeError(`groupBy: "${name}" cannot name a measure.`);
	}
	const given = isRecord(measure) ? Object.keys(measure) : [];
	const operator = OPERATORS.find((op) => given.includes(op));
	const field = operator && (measure as Fields)[operator];
	if (given.length !== 1 || !operator || typeof field !== 'string') {
		throw new TypeError(
			`groupBy: measure "${name}" must be one of { sum | avg | min | max: field }.`,
		);
	}
	return { [`$${operator}`]: `$${field}` };
}

export interface GroupByRuntime {
	filter?: unknown;
	withDeleted?: boolean;
	measures?: Fields;
	sort?: 'count' | 'key';
	limit?: number;
}

/**
 * The documents grouped on one field, with each group's size and the
 * measures asked for. The largest groups come first unless `sort: 'key'`.
 */
export async function groupBy(
	ctx: CollectionContext,
	field: string,
	opts: GroupByRuntime = {},
): Promise<Fields[]> {
	const group: Fields = { _id: `$${field}`, count: { $sum: 1 } };
	for (const [name, measure] of Object.entries(opts.measures ?? {})) {
		group[name] = accumulator(name, measure);
	}
	const sort = opts.sort ?? 'count';
	if (sort !== 'count' && sort !== 'key') {
		throw new TypeError(
			`groupBy: sort is 'count' or 'key', not ${String(sort)}`,
		);
	}
	const pipeline: Fields[] = [
		{ $match: scoped(ctx, opts.filter, opts.withDeleted) },
		{ $group: group },
		// `_id` breaks ties, so that the order is the same from call to call.
		{ $sort: sort === 'count' ? { count: -1, _id: 1 } : { _id: 1 } },
	];
	if (opts.limit !== undefined) {
		if (!Number.isInteger(opts.limit) || opts.limit < 1) {
			throw new TypeError(
				`groupBy: limit must be a whole number of at least 1, not ${String(opts.limit)}`,
			);
		}
		pipeline.push({ $limit: opts.limit });
	}
	return run(ctx, async () => {
		const groups = await ctx.collection
			.aggregate(pipeline, { ...ctx.sessionOption })
			.toArray();
		return groups.map(({ _id, ...rest }) => ({ key: _id ?? null, ...rest }));
	});
}

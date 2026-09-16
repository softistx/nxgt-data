import type { Fields } from '../filters';

/** What `populate` calls on the collection a relation reads from. */
interface Source {
	findMany(options: Fields): Promise<Fields[]>;
}

interface Relation {
	from: Source;
	by?: string;
	on?: string;
	withDeleted?: boolean;
}

/**
 * A key an id can be looked up by: two `ObjectId`s with the same value are
 * two objects, so they are compared by their hex string.
 */
function keyOf(value: unknown): string {
	const hex = (value as { toHexString?: () => string } | null)?.toHexString;
	if (typeof hex === 'function') return `oid:${hex.call(value)}`;
	return `${typeof value}:${String(value)}`;
}

const listOf = (value: unknown): unknown[] =>
	Array.isArray(value)
		? value
		: value === null || value === undefined
			? []
			: [value];

function unique(values: unknown[]): unknown[] {
	const seen = new Map<string, unknown>();
	for (const value of values) seen.set(keyOf(value), value);
	return [...seen.values()];
}

function relationOf(name: string, given: unknown): Relation {
	const relation = given as Partial<Relation> | undefined;
	const by = typeof relation?.by === 'string';
	const on = typeof relation?.on === 'string';
	if (typeof relation?.from?.findMany !== 'function' || by === on) {
		throw new TypeError(
			`populate: "${name}" needs a collection in \`from\`, and one of \`by\` or \`on\`.`,
		);
	}
	return relation as Relation;
}

/** The documents a field points to, one query for all of them. */
async function followBy(documents: Fields[], name: string, r: Relation) {
	const field = r.by as string;
	const ids = unique(documents.flatMap((d) => listOf(d[field])));
	const found =
		ids.length === 0
			? []
			: await r.from.findMany({
					filter: { _id: { $in: ids } },
					sort: { _id: 1 },
					withDeleted: r.withDeleted,
				});
	const byId = new Map(found.map((doc) => [keyOf(doc._id), doc]));
	for (const document of documents) {
		const value = document[field];
		document[name] = Array.isArray(value)
			? value.flatMap((id) => byId.get(keyOf(id)) ?? [])
			: (byId.get(keyOf(value)) ?? null);
	}
}

/** The documents that point to these ones, one query for all of them. */
async function followOn(documents: Fields[], name: string, r: Relation) {
	const field = r.on as string;
	const ids = unique(documents.map((d) => d._id));
	const found =
		ids.length === 0
			? []
			: await r.from.findMany({
					filter: { [field]: { $in: ids } },
					sort: { _id: 1 },
					withDeleted: r.withDeleted,
				});
	const byTarget = new Map<string, Fields[]>();
	for (const doc of found) {
		for (const target of unique(listOf(doc[field]))) {
			const key = keyOf(target);
			byTarget.set(key, [...(byTarget.get(key) ?? []), doc]);
		}
	}
	for (const document of documents) {
		document[name] = byTarget.get(keyOf(document._id)) ?? [];
	}
}

/**
 * The documents given, each with its related documents under the
 * relation's name: one query per relation, whatever the number of
 * documents. The related collection reads as it always does — its session,
 * its soft delete.
 *
 * It returns copies; the documents given are left as they were.
 */
export async function populate(
	documents: readonly unknown[],
	relations: Fields,
): Promise<Fields[]> {
	const copies = documents.map((d) => ({ ...(d as Fields) }));
	const checked = Object.entries(relations).map(
		([name, given]) => [name, relationOf(name, given)] as const,
	);
	await Promise.all(
		checked.map(([name, relation]) =>
			relation.by !== undefined
				? followBy(copies, name, relation)
				: followOn(copies, name, relation),
		),
	);
	return copies;
}

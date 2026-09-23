import {
	MeilisearchApiError,
	type RecordAny,
	type SearchParams,
} from 'meilisearch';
import type { IndexContext } from '../context';
import type { FieldsOptions, ListQuery } from '../types';

export async function get(
	ctx: IndexContext,
	id: unknown,
	options?: FieldsOptions<string>,
) {
	try {
		return await ctx.raw.getDocument(
			id as string | number,
			options?.fields ? { fields: [...options.fields] } : undefined,
		);
	} catch (error) {
		if (
			error instanceof MeilisearchApiError &&
			error.cause?.code === 'document_not_found'
		) {
			return undefined;
		}
		throw error;
	}
}

export async function getMany(
	ctx: IndexContext,
	ids: readonly unknown[],
	options?: FieldsOptions<string>,
) {
	if (ids.length === 0) return [];
	const { results } = await ctx.raw.getDocuments<RecordAny>({
		ids: [...ids] as string[],
		limit: ids.length,
		...(options?.fields ? { fields: [...options.fields] } : {}),
	});
	return results;
}

/** The query's `Def` only types its `sort`; any definition's is read the same. */
export async function list(
	ctx: IndexContext,
	query: ListQuery<any, string> = {},
) {
	const { fields, sort, ...rest } = query;
	const page = await ctx.raw.getDocuments<RecordAny>({
		...rest,
		...(fields ? { fields: [...fields] } : {}),
		...(sort ? { sort: [...sort] } : {}),
	});
	return {
		results: page.results,
		total: page.total,
		offset: page.offset ?? query.offset ?? 0,
		limit: page.limit ?? query.limit ?? page.results.length,
	};
}

export function search(
	ctx: IndexContext,
	query: string | null | undefined,
	options: unknown,
) {
	return ctx.raw.search(query, options as SearchParams | undefined);
}

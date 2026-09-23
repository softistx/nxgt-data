// A typed Meilisearch index: its definition, its settings kept in sync, and
// its documents and searches typed by it. Built on the official `meilisearch`
// SDK, whose client, errors and tasks it uses as they are.

export type {
	AnyIndexDefinition,
	DocumentOf,
	FilterableOf,
	GranularFilterableAttribute,
	IdOf,
	IndexConfig,
	IndexDefinition,
	IndexSettings,
	LocalizedAttribute,
	PrimaryKeyNameOf,
	PrimaryKeyOf,
	RankingRule,
	SearchableOf,
	SortableOf,
} from './definition/define-index';
export { defineIndex } from './definition/define-index';
export type { AttributePattern, DocumentPath } from './definition/paths';
export type {
	SearchIndexErrorCode,
	SearchIndexErrorOptions,
} from './errors/search-index-error';
export { SearchIndexError } from './errors/search-index-error';
export type { TypedIndex } from './index/bind-index';
export { bindIndex } from './index/bind-index';
export type {
	AttributeOrWildcard,
	BatchWriteOptions,
	BatchWriteResult,
	DocumentPage,
	DocumentPatch,
	FieldOf,
	FieldsOptions,
	ListQuery,
	OrderDirection,
	SearchOptions,
	SearchResult,
	Selected,
	SortExpression,
	WriteOptions,
	WriteResult,
} from './index/types';
export type {
	CheckedQuery,
	MultiSearchQuery,
	MultiSearchResults,
} from './search/multi-search';
export { multiSearch } from './search/multi-search';
export type {
	RebuildDefinition,
	RebuildFill,
	RebuildOptions,
	RebuildReport,
} from './sync/rebuild-index';
export type { WantedSettings } from './sync/settings-diff';
export { diffSettings } from './sync/settings-diff';
export type { SyncOptions, SyncReport } from './sync/sync-index';
export { syncIndex, syncIndexes } from './sync/sync-index';
export type {
	TenantTokenOptions,
	TenantTokenRule,
	TenantTokenRules,
	TokenIndexes,
} from './token/tenant-token';
export { tenantToken } from './token/tenant-token';

export type {
	ByRelation,
	DistinctOf,
	Group,
	GroupByOptions,
	GroupKeyOf,
	Measure,
	Measures,
	NumericFieldOf,
	OnRelation,
	Populated,
	ReferenceFieldOf,
	RelatedCollection,
	Relations,
} from './collection/aggregation/types';
export { resetAutoSync } from './collection/auto-sync';
export type {
	ChangeHandler,
	ChangeOf,
	ChangeOptions,
	ChangeSubscription,
	ChangeType,
	CloseReason,
	CreateChange,
	DeleteChange,
	RestoreChange,
	ResumeToken,
	UpdateChange,
} from './collection/changes/types';
export {
	type CollectionSource,
	getCollection,
} from './collection/get-collection';
export type {
	AfterHook,
	BeforeHook,
	CollectionHooks,
	CreateArgs,
	DeleteArgs,
	DeleteHookContext,
	DeleteManyArgs,
	HookContext,
	UpdateArgs,
	UpdateManyArgs,
	WriteOperation,
} from './collection/hooks/types';
export type {
	ActorOf,
	CollectionApi,
	CollectionOptions,
	CursorPaginateOptions,
	FieldPath,
	FindFirstOptions,
	FindManyOptions,
	IfStamp,
	OrderDirection,
	PaginateOptions,
	Patch,
	ProjectionOf,
	ProjectionOperator,
	PushOf,
	ReadOptions,
	SetOf,
	SortOf,
	TypedCollection,
	UpdateOperators,
	UpdateOptions,
} from './collection/types';
export {
	closeMongo,
	connectMongo,
	type MongoConnection,
	type PingResult,
} from './connection/connect';
export {
	type CappedOption,
	type ClusteredIndexOption,
	creationOptionsOf,
	type MongoCollectionOptions,
	type TimeseriesGranularity,
	type TimeseriesOption,
} from './definition/collection-options';
export {
	type AnyCollectionDefinition,
	type CollectionConfig,
	type CollectionDefinition,
	type CollectionIndex,
	type DocumentOf,
	defineCollection,
	type FieldOf,
	type IdOf,
	type IndexKey,
	type NewDocumentOf,
	type ReadDocumentOf,
	type StampedSchema,
} from './definition/define-collection';
export {
	type ActorField,
	actorFieldOf,
	type DeletedAtField,
	deletedAtField,
	id,
	objectId,
	STAMP_FIELDS,
	type StampKind,
	type TimestampField,
	timestampField,
	type VersionField,
	versionField,
} from './definition/fields';
export {
	MONGO_JSON_SCHEMA_KEYWORDS,
	toMongoJsonSchema,
} from './definition/json-schema';
export {
	isObjectId,
	isObjectIdString,
	isValidObjectId,
	objectIdParam,
	toObjectId,
	toObjectIds,
	tryObjectId,
} from './definition/object-id';
export {
	type ActorsChoice,
	type ActorsOption,
	type FieldForName,
	type LockChoice,
	type LockOption,
	type MemberNameOf,
	type NameFor,
	type NameOption,
	resolveStampNames,
	type SoftDeleteChoice,
	type SoftDeleteOption,
	type StampNames,
	type StampNamesOf,
	type StampOptions,
	type StampShape,
	stampShapeOf,
	type TimestampsChoice,
	type TimestampsOption,
} from './definition/stamps';
export {
	resolveValidation,
	type ValidationAction,
	type ValidationConfig,
	type ValidationLevel,
} from './definition/validation';
export {
	ConflictError,
	DataError,
	type DataErrorCode,
	type DataErrorOptions,
	InvalidCursorError,
	InvalidIdError,
	NotFoundError,
	OptimisticLockError,
	ValidationError,
	type ValidationIssue,
} from './errors/data-error';
export { toDataError } from './errors/to-data-error';
export {
	type CursorPayload,
	decodeCursor,
	encodeCursor,
} from './pagination/cursor';
export {
	type CursorPage,
	cursorLimit,
	DEFAULT_MAX_PAGE_SIZE,
	DEFAULT_PAGE_SIZE,
	type Page,
	type PageOptions,
	type PageWindow,
	pageWindow,
	toPage,
} from './pagination/page';
export {
	diffIndexes,
	type IndexDiff,
	indexMatches,
	indexNameOf,
	type NormalizedIndex,
	normalizeIndex,
} from './sync/index-diff';
export {
	collModForOptions,
	diffCollectionOptions,
	immutableOptionsError,
	type OptionMismatch,
} from './sync/options-diff';
export {
	clearCollectionRegistry,
	registerCollection,
	registeredCollections,
} from './sync/registry';
export { syncAll } from './sync/sync-all';
export {
	type SyncOptions,
	type SyncReport,
	syncCollection,
	syncCollections,
} from './sync/sync-collection';
export {
	hasValidator,
	type LiveValidation,
	validationMatches,
	type WantedValidation,
} from './sync/validator-diff';
export {
	type TransactionHost,
	withTransaction,
} from './transaction/with-transaction';

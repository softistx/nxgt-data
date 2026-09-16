import {
	ConflictError,
	DataError,
	type DataErrorOptions,
	ValidationError,
	type ValidationIssue,
} from './data-error';

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	return value === undefined || value === null ? [] : [value];
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * The index a duplicate key names. The message is the only place it is:
 * `E11000 duplicate key error collection: db.users index: users_email_unique
 * dup key: { email: "a@b.c" }`.
 */
function indexFromMessage(message: string | undefined): string | undefined {
	return message?.match(/index:\s*(\S+)\s+dup key/)?.[1];
}

/**
 * The keys of a duplicate key. `keyPattern` carries them for a single write;
 * a bulk write carries neither it nor `keyValue`, and the message is all there
 * is: `dup key: { email: "a@b.c", tenant: 1 }`.
 */
function keysOfDuplicate(error: Record_): {
	keys: string[];
	values: Record_ | undefined;
} {
	const pattern = error.keyPattern;
	if (isRecord(pattern)) {
		const values = isRecord(error.keyValue) ? error.keyValue : undefined;
		return { keys: Object.keys(pattern), values };
	}
	const inMessage = text(error.errmsg)?.match(/dup key:\s*\{([^}]*)\}/)?.[1];
	if (!inMessage) return { keys: [], values: undefined };
	const keys = [...inMessage.matchAll(/([\w.$]+)\s*:/g)].map(
		(match) => match[1] as string,
	);
	return { keys, values: undefined };
}

/** The first write error of a bulk result, which may be one object or a list. */
function firstWriteError(error: Record_): Record_ | undefined {
	for (const write of asArray(error.writeErrors)) {
		// The driver wraps each one; its fields sit on `err` there.
		const inner = isRecord(write) && isRecord(write.err) ? write.err : write;
		if (isRecord(inner)) return inner;
	}
	return undefined;
}

/**
 * The issues of a `$jsonSchema` failure, from `errInfo.details`. The server
 * nests them: `schemaRulesNotSatisfied` holds `propertiesNotSatisfied`, whose
 * `details` hold either leaf rules or another level of properties.
 */
function issuesOf(details: unknown, path: string[] = []): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const rule of asArray(details)) {
		if (!isRecord(rule)) continue;

		if (rule.propertiesNotSatisfied !== undefined) {
			for (const property of asArray(rule.propertiesNotSatisfied)) {
				if (!isRecord(property)) continue;
				const name = text(property.propertyName) ?? '';
				const nested = issuesOf(property.details, [...path, name]);
				const description = text(property.description);
				issues.push(
					...(description === undefined
						? nested
						: nested.map((issue) => ({ description, ...issue }))),
				);
			}
			continue;
		}

		if (rule.missingProperties !== undefined) {
			for (const missing of asArray(rule.missingProperties)) {
				issues.push({
					path: [...path, String(missing)].join('.'),
					reason: 'required',
					specifiedAs: rule.specifiedAs,
				});
			}
			continue;
		}

		if (rule.schemaRulesNotSatisfied !== undefined) {
			issues.push(...issuesOf(rule.schemaRulesNotSatisfied, path));
			continue;
		}

		issues.push({
			path: path.join('.'),
			reason: text(rule.reason) ?? text(rule.operatorName) ?? 'invalid',
			...(rule.specifiedAs === undefined
				? {}
				: { specifiedAs: rule.specifiedAs }),
			...(rule.consideredValue === undefined
				? {}
				: { consideredValue: rule.consideredValue }),
			...(text(rule.consideredType) === undefined
				? {}
				: { consideredType: text(rule.consideredType) }),
		});
	}
	return issues;
}

/**
 * A MongoDB error as one of this package's, or the error itself when it is
 * none of them.
 *
 * It reads the error's fields rather than its class: a duplicate key arrives
 * as a `MongoServerError` with `keyPattern` from `insertOne`, and as a
 * `MongoBulkWriteError` whose `writeErrors` carry neither `keyPattern` nor
 * `keyValue` from `insertMany` and `bulkWrite`. Both become a `ConflictError`
 * with the same fields. Reading fields also survives two copies of the driver
 * in one tree, where `instanceof` does not.
 */
export function toDataError(
	error: unknown,
	context: { collection?: string | undefined } = {},
): unknown {
	if (error instanceof DataError) return error;
	if (!isRecord(error)) return error;

	// A bulk write carries the detail on its write errors, and only a message
	// at the top; a single write carries everything at the top.
	const source = firstWriteError(error) ?? error;
	const code =
		typeof source.code === 'number'
			? source.code
			: typeof error.code === 'number'
				? error.code
				: undefined;
	if (typeof code !== 'number') return error;

	const message =
		text(source.errmsg) ??
		text(source.message) ??
		text((error as { message?: unknown }).message) ??
		'';
	const common: DataErrorOptions = {
		collection: context.collection,
		serverCode: code,
		serverCodeName: text(error.codeName) ?? text(source.codeName),
		cause: error,
	};

	if (code === 11000) {
		const { keys, values } = keysOfDuplicate(source);
		const index = indexFromMessage(message);
		const named =
			keys.length > 0 ? keys.join(', ') : (index ?? 'a unique index');
		return new ConflictError(
			`Duplicate key on ${named}${
				context.collection ? ` in "${context.collection}"` : ''
			}`,
			{ ...common, index, keys, values },
		);
	}

	if (code === 121) {
		const errInfo = isRecord(source.errInfo) ? source.errInfo : undefined;
		const issues = issuesOf(errInfo?.details);
		return new ValidationError(
			`Document failed validation${
				context.collection ? ` in "${context.collection}"` : ''
			}${issues.length > 0 ? `: ${issues.map((i) => `${i.path} ${i.reason}`).join(', ')}` : ''}`,
			{ ...common, issues, keys: issues.map((issue) => issue.path) },
		);
	}

	return new DataError(message || `MongoDB error ${code}`, common);
}

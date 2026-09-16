import { describe, expect, test } from 'bun:test';
import {
	ConflictError,
	DataError,
	NotFoundError,
	ValidationError,
} from './data-error';
import { toDataError } from './to-data-error';

/** A duplicate key as `insertOne` throws it: the fields are on the error. */
const singleDuplicate = {
	name: 'MongoServerError',
	code: 11000,
	index: 0,
	keyPattern: { email: 1 },
	keyValue: { email: 'ada@example.com' },
	errmsg:
		'E11000 duplicate key error collection: app.users index: users_email_unique dup key: { email: "ada@example.com" }',
	message:
		'E11000 duplicate key error collection: app.users index: users_email_unique dup key: { email: "ada@example.com" }',
};

/** The same conflict as `insertMany` and `bulkWrite` throw it. */
const bulkDuplicate = {
	name: 'MongoBulkWriteError',
	code: 11000,
	writeErrors: [
		{
			code: 11000,
			index: 1,
			errmsg:
				'E11000 duplicate key error collection: app.users index: users_email_tenant dup key: { email: "ada@example.com", tenant: 1 }',
		},
	],
};

describe('toDataError, on a duplicate key', () => {
	test('reads the keys and values a single write carries', () => {
		const error = toDataError(singleDuplicate, {
			collection: 'users',
		}) as ConflictError;
		expect(error).toBeInstanceOf(ConflictError);
		expect(error).toBeInstanceOf(DataError);
		expect(error.code).toBe('CONFLICT');
		expect(error.serverCode).toBe(11000);
		expect(error.collection).toBe('users');
		expect(error.index).toBe('users_email_unique');
		expect(error.keys).toEqual(['email']);
		expect(error.values).toEqual({ email: 'ada@example.com' });
		expect(error.message).toBe('Duplicate key on email in "users"');
		expect(error.cause).toBe(singleDuplicate);
	});

	test('reads them out of the message a bulk write leaves behind', () => {
		// A bulk write carries neither keyPattern nor keyValue, at the top
		// level or on its writeErrors: the message is all there is.
		const error = toDataError(bulkDuplicate) as ConflictError;
		expect(error).toBeInstanceOf(ConflictError);
		expect(error.index).toBe('users_email_tenant');
		expect(error.keys).toEqual(['email', 'tenant']);
		expect(error.values).toBeUndefined();
	});
});

describe('toDataError, on a failed validator', () => {
	test('flattens errInfo into issues', () => {
		const error = toDataError(
			{
				name: 'MongoServerError',
				code: 121,
				errmsg: 'Document failed validation',
				errInfo: {
					failingDocumentId: 'x',
					details: {
						operatorName: '$jsonSchema',
						schemaRulesNotSatisfied: [
							{
								operatorName: 'properties',
								propertiesNotSatisfied: [
									{
										propertyName: 'name',
										description: 'must be a string',
										details: [
											{
												operatorName: 'bsonType',
												specifiedAs: { bsonType: 'string' },
												reason: 'type did not match',
												consideredValue: 123,
												consideredType: 'int',
											},
										],
									},
								],
							},
							{
								operatorName: 'required',
								specifiedAs: { required: ['email'] },
								missingProperties: ['email'],
							},
						],
					},
				},
			},
			{ collection: 'users' },
		) as ValidationError;

		expect(error).toBeInstanceOf(ValidationError);
		expect(error.code).toBe('VALIDATION');
		expect(error.serverCode).toBe(121);
		expect(error.issues).toEqual([
			{
				description: 'must be a string',
				path: 'name',
				reason: 'type did not match',
				specifiedAs: { bsonType: 'string' },
				consideredValue: 123,
				consideredType: 'int',
			},
			{
				path: 'email',
				reason: 'required',
				specifiedAs: { required: ['email'] },
			},
		]);
		expect(error.keys).toEqual(['name', 'email']);
		expect(error.message).toBe(
			'Document failed validation in "users": name type did not match, email required',
		);
	});

	test('a nested property keeps its path', () => {
		const error = toDataError({
			code: 121,
			errInfo: {
				details: {
					schemaRulesNotSatisfied: [
						{
							operatorName: 'properties',
							propertiesNotSatisfied: [
								{
									propertyName: 'profile',
									details: [
										{
											operatorName: 'properties',
											propertiesNotSatisfied: [
												{
													propertyName: 'city',
													details: [
														{
															operatorName: 'bsonType',
															reason: 'type did not match',
														},
													],
												},
											],
										},
									],
								},
							],
						},
					],
				},
			},
		}) as ValidationError;
		expect(error.issues).toEqual([
			{ path: 'profile.city', reason: 'type did not match' },
		]);
	});
});

describe('toDataError, on anything else', () => {
	test('another server code is a DataError with it', () => {
		const error = toDataError({
			code: 26,
			codeName: 'NamespaceNotFound',
			errmsg: 'ns does not exist',
		}) as DataError;
		expect(error.constructor).toBe(DataError);
		expect(error.code).toBe('DATABASE');
		expect(error.serverCode).toBe(26);
		expect(error.serverCodeName).toBe('NamespaceNotFound');
		expect(error.message).toBe('ns does not exist');
	});

	test('an error without a server code is returned as it is', () => {
		const error = new TypeError('nope');
		expect(toDataError(error)).toBe(error);
		expect(toDataError('text')).toBe('text');
		expect(toDataError(undefined)).toBeUndefined();
	});

	test('one of ours is returned as it is', () => {
		const error = new NotFoundError('gone');
		expect(toDataError(error)).toBe(error);
	});

	test('the errors can be thrown by an application, with defaults', () => {
		expect(new NotFoundError().message).toBe('Not found');
		expect(new NotFoundError().code).toBe('NOT_FOUND');
		expect(new ConflictError().serverCode).toBe(11000);
		expect(new ValidationError().serverCode).toBe(121);
		expect(new DataError('x').keys).toEqual([]);
		expect(new DataError('x').issues).toEqual([]);
	});
});

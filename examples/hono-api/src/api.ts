import { createApi } from './generated/hono';

/**
 * One registry for the whole spec, shared by every module: each registers
 * its own routes against it, and `assertComplete` refuses to start with an
 * operation nobody serves. It is a module, not an argument, so a module
 * declares its routes on its own — nothing has to be handed down to it.
 */
export const api = createApi({
	// Every reply is checked against the spec. It reads each body twice, so
	// it is for development and tests, never for production.
	validateResponses: process.env.NODE_ENV !== 'production',
});

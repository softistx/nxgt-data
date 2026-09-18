import { beforeAll } from 'bun:test';
import type { Hono } from 'hono';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/app';
import type { Env } from '../src/context';
import { useKit } from './kit';

/** Somebody who exists nowhere: the caller of a request that names no one real. */
export const stranger = new ObjectId().toHexString();

/**
 * The application over a mongod of its own, and the two things every route
 * spec does: send a request, and create a user to send it as. A module's
 * route spec calls only its own routes through it.
 */
export function useApi(database: string) {
	const state = useKit(database);
	let app: Hono<Env>;

	beforeAll(() => {
		app = buildApp(state.kit);
	});

	/** A request, as a client would send it. `as: null` names no user at all. */
	async function call(
		path: string,
		init: RequestInit & { as?: string | null } = {},
	): Promise<Response> {
		const { as = stranger, ...rest } = init;
		// `app.request` may answer without awaiting anything, so this is
		// `async`: a helper that announces a promise always gives one.
		return app.request(path, {
			...rest,
			headers: {
				'content-type': 'application/json',
				...(as === null ? {} : { 'x-user-id': as }),
				...init.headers,
			},
		});
	}

	/** A user to write as, created through the API like everything else. */
	async function newUser(email = 'ada@example.com'): Promise<string> {
		const created = await call('/users', {
			method: 'POST',
			body: JSON.stringify({ email }),
		});
		return ((await created.json()) as { id: string }).id;
	}

	return { kit: state, call, newUser };
}

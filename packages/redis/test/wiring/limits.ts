import { defineRateLimit } from '../../src/rate-limit/define-rate-limit';

/** Five a minute per address. */
export const login = defineRateLimit({
	name: 'login',
	key: (params: { ip: string }) => params.ip,
	limit: 5,
	per: 60_000,
});

/** Keyed by more than one thing, which is why `key` takes an object. */
export const exports = defineRateLimit({
	name: 'export',
	key: (params: { org: string; user: string }) =>
		`${params.org}/${params.user}`,
	limit: 10,
	per: 60_000,
	burst: 20,
});

/** Not a definition: the scope must skip it rather than trip over it. */
export const LIMIT_NOTE = 'exported beside the definitions, on purpose';

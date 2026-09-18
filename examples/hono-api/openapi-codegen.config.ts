import { defineConfig } from '@nxgt/openapi-codegen';

/**
 * The spec is the source: `bun run generate:api` writes `src/generated`,
 * which is git-ignored and rebuilt before every typecheck and test run.
 *
 * `lint: true` runs Redocly first, with the `redocly.yaml` beside the spec.
 */
export default defineConfig({
	input: 'openapi/openapi.yaml',
	output: 'src/generated',
	hono: true,
	lint: true,
});

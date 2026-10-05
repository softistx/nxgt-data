import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { defineScript, runScript } from './run-script';

const servers = useRedis();

const ECHO = defineScript('return ARGV[1]');

describe('runScript', () => {
	test('names the script by the SHA-1 Redis itself computes', async () => {
		const sha = await servers.redis.client.script('LOAD', ECHO.source);
		expect(ECHO.sha).toBe(sha);
	});

	test('sends the source again after SCRIPT FLUSH, and the SHA works after', async () => {
		const client = servers.redis.client;
		expect(await runScript(client, ECHO, [], ['one'])).toBe('one');
		await client.send('SCRIPT', ['FLUSH']);
		expect(await client.script('EXISTS', ECHO.sha)).toEqual([0]);

		// The EVALSHA answers NOSCRIPT, and the EVAL behind it loads it again.
		expect(await runScript(client, ECHO, [], ['two'])).toBe('two');
		expect(await client.script('EXISTS', ECHO.sha)).toEqual([1]);
		expect(await client.evalsha(ECHO.sha, 0, 'three')).toBe('three');
	});

	test('passes any other error through, without trying EVAL', async () => {
		const failing = defineScript("return redis.error_reply('OOPS no luck')");
		const client = servers.redis.client;
		await client.script('LOAD', failing.source);
		let evals = 0;
		const counting = new Proxy(client, {
			get(target, property) {
				if (property === 'eval') evals += 1;
				const value = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const error = await rejection(runScript(counting, failing, [], []));
		expect((error as Error).message).toBe('OOPS no luck');
		expect(evals).toBe(0);
	});
});

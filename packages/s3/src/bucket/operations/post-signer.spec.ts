import { describe, expect, test } from 'bun:test';
import { S3Client, type S3Options } from 'bun';
import { avatars } from '../../../test/fixtures';
import { S3Error } from '../../errors/s3-error';
import { bindBucket } from '../bind-bucket';
import { bucketContext, secretOf } from '../context';
import { presignedSignature } from './post-policy';
import { PROBE, signerOf } from './post-signer';
import { presignPostForm } from './presign-post';

// No server: where a form is posted, and as whom, is decided by the URL Bun
// signs, before anything is sent. `MARKER` stands in for a secret — it is
// never a real one, and no assertion here prints it.
const MARKER = 'nxgt-marker-not-a-secret';
const credentials = { accessKeyId: 'a-key-id', secretAccessKey: MARKER };

const formFor = (options: Omit<S3Options, 'bucket'>) =>
	bindBucket(avatars, { ...credentials, ...options }).presignPost(
		{ userId: 'u1' },
		{ type: 'image/png' },
	);

const scopeOf = (fields: Record<string, string>) =>
	fields['x-amz-credential']?.split('/');

describe('where a presigned POST goes, read off the URL Bun signs', () => {
	test('the bucket in the host, with virtualHostedStyle', () => {
		const form = formFor({
			endpoint: 'https://avatars.s3.eu-west-3.amazonaws.com',
			virtualHostedStyle: true,
		});
		expect(form.url).toBe('https://avatars.s3.eu-west-3.amazonaws.com/');
		expect(scopeOf(form.fields)).toEqual([
			'a-key-id',
			expect.stringMatching(/^\d{8}$/),
			'eu-west-3',
			's3',
			'aws4_request',
		]);
	});

	test('the bucket in the path, on AWS, in the region given', () => {
		const form = formFor({ region: 'eu-west-3' });
		expect(form.url).toBe('https://s3.eu-west-3.amazonaws.com/avatars/');
		expect(scopeOf(form.fields)?.[2]).toBe('eu-west-3');
	});

	test('region `auto` at an endpoint that is not AWS’s, as Bun signs it', () => {
		const form = formFor({ endpoint: 'http://127.0.0.1:9000' });
		expect(form.url).toBe('http://127.0.0.1:9000/avatars/');
		expect(scopeOf(form.fields)?.[2]).toBe('auto');
	});

	test('a session token reaches the form, and the policy fixes it', () => {
		const form = formFor({
			endpoint: 'http://127.0.0.1:9000',
			sessionToken: 'a-session-token',
		});
		expect(form.fields['x-amz-security-token']).toBe('a-session-token');
		const policy = JSON.parse(
			Buffer.from(form.fields.policy ?? '', 'base64').toString(),
		);
		expect(policy.conditions).toContainEqual([
			'eq',
			'$x-amz-security-token',
			'a-session-token',
		]);
	});

	test('refuses a signed URL it cannot read, rather than guess', () => {
		// Only a Bun that signs differently would hand this back.
		const shapes = [
			'http://127.0.0.1:9000/avatars/elsewhere?X-Amz-Credential=' +
				encodeURIComponent('k/20260101/auto/s3/aws4_request'),
			`http://127.0.0.1:9000/avatars/${PROBE}?X-Amz-Credential=k`,
		];
		for (const url of shapes) {
			const client = { presign: () => url } as unknown as S3Client;
			const context = bucketContext(client, avatars, MARKER);
			expect(() => signerOf(context)).toThrow(
				'presignPost on "avatars": the URL Bun signed has no credential ' +
					'scope, or not the key at the end of its path',
			);
		}
	});
});

describe('the secret a presigned POST signs with', () => {
	const names = ['S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'] as const;

	/** Runs with these variables set, and puts the environment back. */
	function withEnv(
		values: Partial<Record<(typeof names)[number], string>>,
		run: () => void,
	) {
		const saved = names.map((name) => [name, process.env[name]] as const);
		try {
			for (const name of names) delete process.env[name];
			Object.assign(process.env, values);
			run();
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}

	const client = () =>
		new S3Client({ bucket: 'avatars', endpoint: 'http://127.0.0.1:9000' });

	test('is resolved in Bun’s documented order: the option, S3_, then AWS_', () => {
		withEnv(
			{
				S3_SECRET_ACCESS_KEY: `${MARKER}-s3`,
				AWS_SECRET_ACCESS_KEY: `${MARKER}-aws`,
			},
			() => {
				expect(secretOf(bucketContext(client(), avatars, MARKER))).toBe(MARKER);
				expect(secretOf(bucketContext(client(), avatars))).toBe(`${MARKER}-s3`);
			},
		);
		withEnv({ AWS_SECRET_ACCESS_KEY: `${MARKER}-aws` }, () => {
			expect(secretOf(bucketContext(client(), avatars))).toBe(`${MARKER}-aws`);
		});
		withEnv({}, () => {
			expect(secretOf(bucketContext(client(), avatars))).toBeUndefined();
		});
	});

	test('is never printed: not the context, the bucket, the form or an error', () => {
		const options = { ...credentials, endpoint: 'http://127.0.0.1:9000' };
		const bound = bindBucket(avatars, options);
		const context = bucketContext(
			new S3Client({ ...options, bucket: 'avatars' }),
			avatars,
			MARKER,
		);
		const form = presignPostForm(
			context,
			{ userId: 'u1' },
			{ type: 'image/png' },
		);
		let error: unknown;
		try {
			bound.presignPost({ userId: 'u1' }, { acl: 'everyone' as never });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(S3Error);
		const printed = [context, bound, form, form.fields, error].flatMap(
			(value) => [Bun.inspect(value), JSON.stringify(value) ?? ''],
		);
		printed.push((error as Error).message, (error as Error).stack ?? '');
		for (const text of printed) expect(text.includes(MARKER)).toBe(false);
		// …while it is still the one the form is signed with.
		expect(secretOf(context)).toBe(MARKER);
	});
});

describe('the secret, checked against the signature Bun put on the probe', () => {
	// Recomputing Bun's own signature is how a secret that is not Bun's is
	// told apart before anything is signed. Every shape here was measured to
	// match on bun 1.4.2 — a `+` or a `/` in the access key id included, which
	// Bun writes unencoded.
	const shapes: Omit<S3Options, 'bucket'>[] = [
		{ endpoint: 'http://127.0.0.1:9000', accessKeyId: 'k' },
		{ region: 'eu-west-3', accessKeyId: 'k' },
		{
			endpoint: 'https://avatars.s3.eu-west-3.amazonaws.com',
			virtualHostedStyle: true,
			accessKeyId: 'k',
		},
		{
			endpoint: 'http://127.0.0.1:9000',
			accessKeyId: 'k',
			sessionToken: 'a/token+with=chars&more',
		},
		{ endpoint: 'https://s3.example.com:8443/base', accessKeyId: 'AK/ID+x' },
	];

	test('recomputes Bun’s signature with the same secret, and only that one', () => {
		for (const shape of shapes) {
			const client = new S3Client({
				...shape,
				bucket: 'my.bucket',
				secretAccessKey: MARKER,
			});
			const url = new URL(
				client.presign(PROBE, { method: 'PUT', expiresIn: 1 }),
			);
			const signed = url.search.match(/X-Amz-Signature=([0-9a-f]+)/)?.[1];
			expect(presignedSignature(url, 'PUT', MARKER)).toBe(signed as string);
			expect(presignedSignature(url, 'PUT', `${MARKER}-other`)).not.toBe(
				signed as string,
			);
		}
	});

	test('keeps a `+` in the access key id, which a URL reader turns into a space', () => {
		const form = bindBucket(avatars, {
			endpoint: 'http://127.0.0.1:9000',
			accessKeyId: 'AK+x',
			secretAccessKey: MARKER,
		}).presignPost({ userId: 'u1' }, { type: 'image/png' });
		expect(form.fields['x-amz-credential']).toStartWith('AK+x/');
	});

	/**
	 * `presignPost` in a process started with `S3_SECRET_ACCESS_KEY` set,
	 * which then changes it, deletes it, or leaves it alone. Bun reads the
	 * variable when the process starts; only a fresh process shows that.
	 */
	async function afterStartUp(mode: 'same' | 'changed' | 'deleted') {
		const script = new URL('../../../test/env-drift.ts', import.meta.url)
			.pathname;
		const env: Record<string, string | undefined> = {
			...process.env,
			S3_SECRET_ACCESS_KEY: MARKER,
		};
		delete env.AWS_SECRET_ACCESS_KEY;
		const child = Bun.spawn([process.execPath, 'run', script, mode], {
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const out = await new Response(child.stdout).text();
		await child.exited;
		// What the child printed never holds the secret, whatever it was.
		expect(out.includes(MARKER)).toBe(false);
		return JSON.parse(out) as {
			signed?: boolean;
			name?: string;
			message?: string;
		};
	}

	test('signs when the environment is as it was at start-up', async () => {
		expect(await afterStartUp('same')).toEqual({ signed: true });
	});

	test('refuses a secret changed after start-up, which Bun never saw', async () => {
		// Before this check the form was signed with the new secret and the
		// probe — and every other call — with the old: a form the service
		// refuses only when a browser posts it.
		const result = await afterStartUp('changed');
		expect(result.name).toBe('TypeError');
		expect(result.message).toStartWith(
			'presignPost on "avatars": the secret access key this package would ' +
				'sign with is not the one Bun signs with',
		);
	});

	test('refuses a secret deleted after start-up, which Bun still has', async () => {
		const result = await afterStartUp('deleted');
		expect(result.name).toBe('TypeError');
		expect(result.message).toStartWith(
			'presignPost on "avatars": no secret access key to sign with, while ' +
				'Bun has one',
		);
	});
});

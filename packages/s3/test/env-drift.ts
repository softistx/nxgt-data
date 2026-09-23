// Run by `post-signer.spec.ts` in a process of its own, started with
// `S3_SECRET_ACCESS_KEY` already set: Bun reads that variable when the process
// starts, and only a fresh process can show what changing it afterwards does.
// It prints what `presignPost` did — never a secret: an error's class, code
// and message, which the spec also checks for the marker.
import { bindBucket } from '../src/bucket/bind-bucket';
import { defineBucket } from '../src/bucket/define-bucket';

const mode = process.argv[2];
if (mode === 'changed') {
	process.env.S3_SECRET_ACCESS_KEY = `${process.env.S3_SECRET_ACCESS_KEY}-changed`;
} else if (mode === 'deleted') {
	delete process.env.S3_SECRET_ACCESS_KEY;
}

const bucket = bindBucket(
	defineBucket({ bucket: 'avatars', key: (id: string) => id, maxSize: 10 }),
	{ endpoint: 'http://127.0.0.1:9000', accessKeyId: 'a-key-id' },
);
try {
	const form = bucket.presignPost('u1');
	console.log(
		JSON.stringify({ signed: typeof form.fields.policy === 'string' }),
	);
} catch (error) {
	const { name, message } = error as Error;
	const { code } = error as { code?: string };
	console.log(JSON.stringify({ name, code, message }));
}

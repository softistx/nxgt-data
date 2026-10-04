#!/usr/bin/env bun
/**
 * The `nxgt-mongo-backup` bin. One command, `keygen <path>`: a new key file
 * for `mongoBackups`, readable by its owner alone. It prints the recipient
 * — the public half — and never a secret.
 */
import { isAbsolute, resolve } from 'node:path';
import { generateKeyFile } from './backups/key-file';

const USAGE = 'usage: nxgt-mongo-backup keygen <path>';
const [command, path] = Bun.argv.slice(2);
if (command === '--help' || command === '-h') {
	console.log(USAGE);
	process.exit(0);
}
if (command !== 'keygen' || !path) {
	console.error(USAGE);
	process.exit(2);
}
const file = isAbsolute(path) ? path : resolve(path);
try {
	const { recipient } = await generateKeyFile(file);
	console.log(`key file written: ${file}`);
	console.log(`recipient: ${recipient}`);
	console.log('keep a copy of it away from the backups');
} catch (error) {
	const code = (error as { code?: unknown }).code;
	console.error(
		code === 'EEXIST'
			? `${file} is already there: it is never overwritten`
			: `keygen failed: ${(error as Error).message}`,
	);
	process.exit(1);
}

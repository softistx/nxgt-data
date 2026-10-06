import { describe, expect, test } from 'bun:test';
import {
	type Installed,
	shipsTypes,
	typelessImports,
	typesPackageOf,
} from './types';

/** A package as installed: its manifest and the files its folder holds. */
function installed(
	manifest: Record<string, unknown>,
	files: readonly string[] = [],
): Installed {
	const held = new Set(files);
	return { manifest, has: (rel) => held.has(rel.replace(/^\.\//, '')) };
}

describe('typesPackageOf', () => {
	test('maps a plain name and a scoped one to their @types package', () => {
		expect(typesPackageOf('nodemailer')).toBe('@types/nodemailer');
		expect(typesPackageOf('@babel/core')).toBe('@types/babel__core');
	});
});

describe('shipsTypes', () => {
	test('reads a types or typings field whose file is there', () => {
		expect(
			shipsTypes(
				installed({ types: './dist/index.d.ts' }, ['dist/index.d.ts']),
			),
		).toBe(true);
		expect(
			shipsTypes(installed({ typings: 'lib/main.d.ts' }, ['lib/main.d.ts'])),
		).toBe(true);
		expect(shipsTypes(installed({ types: './dist/index.d.ts' }))).toBe(false);
	});

	test('reads a types condition anywhere in exports', () => {
		expect(
			shipsTypes(
				installed({
					exports: {
						'.': { import: { types: './a.d.mts', default: './a.mjs' } },
					},
				}),
			),
		).toBe(true);
	});

	test('reads a declaration file beside an exports target or main', () => {
		expect(
			shipsTypes(
				installed({ exports: { '.': './dist/index.js' } }, [
					'dist/index.js',
					'dist/index.d.ts',
				]),
			),
		).toBe(true);
		expect(
			shipsTypes(
				installed({ main: 'lib/x.cjs' }, ['lib/x.cjs', 'lib/x.d.cts']),
			),
		).toBe(true);
	});

	test('reads an index.d.ts at the root and typesVersions', () => {
		expect(shipsTypes(installed({}, ['index.d.ts']))).toBe(true);
		expect(shipsTypes(installed({ typesVersions: { '*': {} } }))).toBe(true);
	});

	test('refuses a package that ships JavaScript alone', () => {
		expect(
			shipsTypes(
				installed(
					{ main: 'lib/index.js', exports: { '.': './lib/index.js' } },
					['lib/index.js'],
				),
			),
		).toBe(false);
	});
});

describe('typelessImports', () => {
	const shared = { name: '@nxgt/shared' };
	const nodemailer = installed({ main: 'lib/nodemailer.js' }, [
		'lib/nodemailer.js',
	]);
	const mailer: [string, string] = [
		'dist/types/mailer.d.ts',
		"import type { Transporter } from 'nodemailer';\nexport type M = Transporter;",
	];

	test('flags a typeless package whose @types is only a devDependency', () => {
		const manifest = {
			...shared,
			dependencies: { nodemailer: '^7.0.0' },
			devDependencies: { '@types/nodemailer': '^7.0.0' },
		};
		expect(
			typelessImports(manifest, [mailer], (name) =>
				name === 'nodemailer' ? nodemailer : undefined,
			),
		).toEqual([['dist/types/mailer.d.ts', 'nodemailer', 'no types']]);
	});

	test('passes @types declared in dependencies, peers or optional ones', () => {
		for (const field of [
			'dependencies',
			'peerDependencies',
			'optionalDependencies',
		]) {
			expect(
				typelessImports(
					{
						...shared,
						dependencies: { nodemailer: '^7.0.0' },
						[field]: { nodemailer: '^7.0.0', '@types/nodemailer': '^7.0.0' },
					},
					[mailer],
					() => nodemailer,
				),
			).toEqual([]);
		}
	});

	test('passes a package that ships its own types', () => {
		expect(
			typelessImports(
				{ ...shared, peerDependencies: { zod: '^4.0.0' } },
				[['dist/a.d.ts', "export type { ZodType } from 'zod/v4';"]],
				() => installed({ types: 'index.d.ts' }, ['index.d.ts']),
			),
		).toEqual([]);
	});

	test('maps a scoped package to @types/scope__name', () => {
		const babel: [string, string] = [
			'dist/a.d.ts',
			"import type { PluginObj } from '@babel/core';\nexport type P = PluginObj;",
		];
		const bare = installed({ main: 'lib/index.js' }, ['lib/index.js']);
		expect(
			typelessImports(
				{
					...shared,
					dependencies: { '@babel/core': '^7', '@types/babel__core': '^7' },
				},
				[babel],
				() => bare,
			),
		).toEqual([]);
		expect(
			typelessImports(
				{ ...shared, dependencies: { '@babel/core': '^7' } },
				[babel],
				() => bare,
			),
		).toEqual([['dist/a.d.ts', '@babel/core', 'no types']]);
	});

	test('skips the runtime, relative files, the package itself and .js', () => {
		expect(
			typelessImports(
				shared,
				[
					[
						'dist/a.d.ts',
						[
							'/// <reference types="bun" />',
							"import type { Readable } from 'node:stream';",
							"import type { EventEmitter } from 'events';",
							"import type { Server } from 'bun';",
							"import type { Reply } from './reply';",
							"export type { X } from '@nxgt/shared/types';",
						].join('\n'),
					],
					['dist/a.js', 'import "nodemailer";'],
				],
				() => nodemailer,
			),
		).toEqual([]);
	});

	test('reports a package that is not installed, since nothing can say', () => {
		expect(
			typelessImports(
				{ ...shared, peerDependencies: { ghost: '1' } },
				[['dist/a.d.ts', "export type { G } from 'ghost';"]],
				() => undefined,
			),
		).toEqual([['dist/a.d.ts', 'ghost', 'not installed']]);
	});
});

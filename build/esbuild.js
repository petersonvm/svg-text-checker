/* eslint-disable @typescript-eslint/no-var-requires */
const { build } = require('esbuild');
const { join } = require('path');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
	entryPoints: [join('src', 'extension.ts')],
	outfile: join('dist', 'extension.js'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	sourcemap: true,
	target: 'node18',
	external: ['vscode'],
	logLevel: 'info'
};

async function run() {
	if (watch) {
		const ctx = await build({ ...common, watch: true });
		console.log('Watching for changes...');
		return ctx;
	}
	await build(common);
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});

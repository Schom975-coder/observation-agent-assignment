#!/usr/bin/env node
// Entry point. Checks that this Node can run TypeScript sources directly (type stripping),
// then hands off to the CLI. Plain JavaScript so the check itself runs on any Node.
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
if (!supported) {
  console.error(
    `obs: Node ${process.versions.node} is too old. Install Node 22.18 or newer from https://nodejs.org ` +
      '(it runs the TypeScript sources directly, with no build step).',
  );
  process.exit(1);
}
const { main } = await import('./src/cli.ts');
process.exitCode = await main(process.argv.slice(2));

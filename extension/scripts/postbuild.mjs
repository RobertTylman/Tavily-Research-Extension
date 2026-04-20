import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const distDir = resolve('dist');
const manifestSource = resolve('public/manifest.json');
const manifestTarget = resolve('dist/manifest.json');
const iconsSource = resolve('public/icons');
const iconsTarget = resolve('dist/icons');

await mkdir(distDir, { recursive: true });
await cp(manifestSource, manifestTarget);
await cp(iconsSource, iconsTarget, { recursive: true });

import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(__dirname, 'icon.svg'));
const outDir = join(__dirname, '../public/icons');

await sharp(svg).resize(192, 192).png().toFile(join(outDir, 'icon-192.png'));
console.log('✓ icon-192.png');

await sharp(svg).resize(512, 512).png().toFile(join(outDir, 'icon-512.png'));
console.log('✓ icon-512.png');

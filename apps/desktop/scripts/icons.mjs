// Render build/icon.png (512) and build/icon.ico from the favicon. Run once; the outputs are committed.
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync('../web/public/favicon.svg', 'utf8');
const png = (w) => new Resvg(svg, { fitTo: { mode: 'width', value: w } }).render().asPng();
writeFileSync('build/icon.png', png(512));
writeFileSync('build/icon.ico', await pngToIco([png(256), png(128), png(64), png(48), png(32), png(16)]));
console.log('icons written');

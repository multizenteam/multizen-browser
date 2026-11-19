import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
const svg = readFileSync('branding/mark.svg');
const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const chunks = [];
for (const [size, type] of [[16,'icp4'],[32,'icp5'],[64,'icp6'],[128,'ic07'],[256,'ic08'],[512,'ic09'],[1024,'ic10']]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  write(`build/icons/icon-${size}.png`, png);
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
  if (size === 512) for (const path of ['build/icon.png','resources/icons/icon.png','apps/desktop/src/renderer/public/icon.png','apps/desktop/src/renderer/public/logo.png']) write(path, png);
}
const body = Buffer.concat(chunks), header = Buffer.alloc(8);
header.write('icns'); header.writeUInt32BE(body.length + 8, 4);
write('build/icon.icns', Buffer.concat([header, body]));
copyFileSync('branding/mark.svg', 'apps/desktop/src/renderer/public/brand-mark.svg');
console.log('Rendered Sekvona application icons.');

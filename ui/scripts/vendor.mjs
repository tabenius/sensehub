import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)), vendor = path.join(root, 'vendor');
await mkdir(vendor, { recursive: true });
await build({ absWorkingDir: root, entryPoints:['scripts/visualization-entry.js'], bundle:true,
  format:'esm', platform:'browser', minify:true, target:'es2022', outfile:path.join(vendor,'visualization.js') });
await copyFile(path.join(root,'node_modules/uplot/dist/uPlot.min.css'), path.join(vendor,'uPlot.css'));
for (const name of ['uplot','d3-selection','d3-scale','d3-array','d3-color','d3-format','d3-interpolate','d3-time','d3-time-format','internmap']) await copyFile(path.join(root,'node_modules',name,'LICENSE'), path.join(vendor,`${name}-LICENSE.txt`));
console.log('Built local uPlot/D3 assets; no CDN requests at runtime.');

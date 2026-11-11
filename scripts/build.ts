// Build dist/: hashed assets, inlined CSS, precompressed .br/.gz copies for the static server.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 10);

function copyHashed(src: string, name: string, ext: string): string {
  const b = readFileSync(src);
  const file = `${name}.${hash(b)}.${ext}`;
  writeFileSync(join(ASSETS, file), b);
  return `/assets/${file}`;
}

function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

async function build() {
  const t0 = performance.now();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(ASSETS, { recursive: true });
  const campus = copyHashed(join(ROOT, 'public/data/campus.json'), 'campus', 'json');
  const ground = copyHashed(join(ROOT, 'public/data/ground.png'), 'ground', 'png');
  const out = await Bun.build({
    entrypoints: [join(ROOT, 'src/main.ts')],
    outdir: ASSETS,
    naming: 'app.[hash].[ext]',
    target: 'browser',
    format: 'esm',
    minify: true,
    sourcemap: 'none',
    define: { __CAMPUS_URL__: JSON.stringify(campus), __GROUND_URL__: JSON.stringify(ground) },
  });
  if (!out.success) {
    for (const l of out.logs) console.error(l);
    throw new Error('bundle failed');
  }
  const js = out.outputs.find((o) => o.path.endsWith('.js'))!;
  const jsUrl = '/assets/' + js.path.split('/').pop();
  const css = minifyCss(readFileSync(join(ROOT, 'src/style.css'), 'utf8'));
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    .replace('<!--STYLE-->', `<style>${css}</style>\n  <link rel="preload" href="${campus}" as="fetch" crossorigin>\n  <link rel="preload" href="${ground}" as="fetch" crossorigin>`)
    .replace('<!--SCRIPT-->', `<script type="module" src="${jsUrl}"></script>`);
  writeFileSync(join(DIST, 'index.html'), html);

  let total = 0, totalBr = 0;
  const files = [join(DIST, 'index.html'), ...readdirSync(ASSETS).map((f) => join(ASSETS, f))];
  for (const f of files) {
    const b = readFileSync(f);
    total += b.length;
    if (/\.(js|json|html|css|svg)$/.test(f)) {
      const br = brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      writeFileSync(f + '.br', br);
      writeFileSync(f + '.gz', gzipSync(b, { level: 9 }));
      totalBr += br.length;
    } else totalBr += b.length;
  }
  const kb = (n: number) => (n / 1024).toFixed(1) + ' KB';
  console.log(`built in ${(performance.now() - t0).toFixed(0)} ms: ${files.map((f) => `${f.split('/').pop()} ${kb(statSync(f).size)}`).join(', ')}`);
  console.log(`total ${kb(total)}, over the wire ~${kb(totalBr)}`);
}

await build();

if (process.argv.includes('--watch')) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const again = () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e)), 120);
  };
  for (const d of ['src', 'shared', 'public']) watch(join(ROOT, d), { recursive: true }, again);
  watch(join(ROOT, 'index.html'), again);
  console.log('watching for changes…');
}

// Review frames for the cut-out full-body samples, rendered with the real runtime in
// headless Chromium. Every parameter is pinned, so idle motion and sway are off.
//   node tools/review-cutout.mjs [--out work/cutout-review] [sample ...]
// Writes <out>/<sample>-<frame>.png and prints how far the rest frame is from the same
// avatar drawn without parts (WebGL rounding on soft edges is a few levels).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outDir = resolve(root, outAt >= 0 ? args[outAt + 1] : 'work/cutout-review');
const named = args.filter((arg, i) => !arg.startsWith('--') && i !== outAt + 1);
const SAMPLES = named.length ? named : ['full-body-vest', 'full-body-coat', 'full-body-photo'];

async function assetMap(project, withParts) {
  const assets = {};
  const add = async (name, sub = '') => {
    const path = resolve(project, 'built', sub, name);
    if (!existsSync(path)) return;
    assets[sub ? `${sub}/${name}` : name] = `data:${name.endsWith('.png') ? 'image/png' : 'application/json'};base64,${(await readFile(path)).toString('base64')}`;
  };
  await add('layers.json');
  const layers = JSON.parse(await readFile(resolve(project, 'built/layers.json'), 'utf8'));
  await Promise.all(['base', 'hairmask', ...Object.keys(layers.layers)].map(name => add(`${name}.png`)));
  for (const [sub, file] of [['sprites', 'sprites.json'], ...(withParts ? [['parts', 'parts.json']] : [])]) {
    if (!existsSync(resolve(project, 'built', sub, file))) continue;
    await add(file, sub);
    const sheet = JSON.parse(await readFile(resolve(project, 'built', sub, file), 'utf8'));
    await Promise.all(Object.keys(sheet.layers).map(name => add(`${name}.png`, sub)));
  }
  return assets;
}

// Frames, as [name, parameters, joint swings in degrees]. Image-left is L; a positive swing
// turns a downward bone toward image-left, so +50 on shoulderL raises that arm sideways.
const FRAMES = [
  ['rest', {}, {}],
  ['armL50', {}, { shoulderL: 50 }],
  ['armR50', {}, { shoulderR: -50 }],
  ['elbow', {}, { shoulderL: 35, elbowL: -70, shoulderR: -20, elbowR: 60 }],
  ['elbowL', {}, { elbowL: -60, elbowR: 60 }],
  ['kneeL', {}, { kneeL: -45 }],
  ['sit', {}, { hipL: -25, kneeL: -60, hipR: 15, kneeR: 30 }],
  ['yawR', { bodyAngleX: 8, angleX: 18 }, {}],
  ['yawL', { bodyAngleX: -8, angleX: -18 }, {}],
  ['eyesClosed', { eyeLOpen: 0, eyeROpen: 0 }, {}],
  ['eyesHalf', { eyeLOpen: 0.5, eyeROpen: 0.5 }, {}],
  ['eyesSmile', { eyeLOpen: 0, eyeROpen: 0, eyeSmile: 1, eyeSmileL: 1 }, {}],
  ['mouthA', { mouthOpen: 0.9, mouthForm: 0 }, {}],
  ['mouthI', { mouthOpen: 0.9, mouthForm: -0.9 }, {}],
  ['mouthU', { mouthOpen: 0.9, mouthForm: 0.95 }, {}],
  ['mouthE', { mouthOpen: 0.9, mouthForm: -0.38 }, {}],
  ['mouthO', { mouthOpen: 0.9, mouthForm: 0.55 }, {}],
];

async function main() {
  const server = await createServer({
    root, configFile: false, publicDir: false, appType: 'custom', cacheDir: 'node_modules/.vite-cutout-review',
    optimizeDeps: { noDiscovery: true, entries: [] },
    plugins: [{ name: 'cutout-review', configureServer(instance) {
      instance.middlewares.use((req, res, next) => {
        if (req.url !== '/__cutout_review__') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><body style="margin:0;background:#dedfe5"><canvas id="cut"></canvas><canvas id="plain"></canvas></body></html>');
      });
    } }],
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null, preTransformRequests: false },
    logLevel: 'error',
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1800, height: 2200 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/__cutout_review__`);
    await mkdir(outDir, { recursive: true });
    for (const sample of SAMPLES) {
      const project = resolve(root, 'samples', sample);
      const rig = JSON.parse(await readFile(resolve(project, 'rig.json'), 'utf8'));
      const result = await page.evaluate(async ({ rig, assets, plainAssets, frames }) => {
        const runtime = await import('/packages/runtime/src/index.ts');
        const make = async (id, files) => {
          const canvas = document.getElementById(id);
          // 1:1 with the image, so texels are not minified and the rest frames compare exactly
          canvas.style.width = `${rig.image.width}px`;
          canvas.style.height = `${rig.image.height}px`;
          const avatar = await runtime.createMeshAvatar(canvas, { rig, assets: files, manual: true, padTop: 0, padSide: 0 });
          avatar.setAutoIdle(false); avatar.setAutoMotion(false); avatar.setSwayGain(0);
          return { canvas, avatar };
        };
        const cut = await make('cut', assets);
        const plain = await make('plain', plainAssets);
        const still = Object.fromEntries(runtime.PARAMS.map(p => [p.id, p.def]));
        const grab = canvas => {
          const copy = document.createElement('canvas');
          copy.width = canvas.width; copy.height = canvas.height;
          copy.getContext('2d').drawImage(canvas, 0, 0);
          return copy;
        };
        cut.avatar.setParameters(still); cut.avatar.advance(0);
        plain.avatar.setParameters(still); plain.avatar.advance(0);
        const restCut = grab(cut.canvas), restPlain = grab(plain.canvas);
        const a = restCut.getContext('2d').getImageData(0, 0, restCut.width, restCut.height).data;
        const b = restPlain.getContext('2d').getImageData(0, 0, restPlain.width, restPlain.height).data;
        let worst = 0;
        for (let i = 0; i < a.length; i += 4) {
          for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[i + k] * a[i + 3] - b[i + k] * b[i + 3]) / 255);
          worst = Math.max(worst, Math.abs(a[i + 3] - b[i + 3]));
        }
        const skeleton = runtime.buildSkeleton(rig);
        const urls = { restPlain: restPlain.toDataURL('image/png') };
        for (const [name, params, joints] of frames) {
          const pose = runtime.restPose(skeleton);
          for (const [joint, degrees] of Object.entries(joints)) pose.joints[joint] = { swing: degrees * Math.PI / 180, twist: 0 };
          cut.avatar.setParameters({ ...still, ...params });
          cut.avatar.setSkeletonPose(pose);
          cut.avatar.advance(0);
          urls[name] = cut.canvas.toDataURL('image/png');
        }
        return { urls, worst };
      }, { rig, assets: await assetMap(project, true), plainAssets: await assetMap(project, false), frames: FRAMES });
      if (errors.length) throw new Error(`${sample}: ${errors.join('\n')}`);
      console.log(`${sample}: rest frame vs no-parts frame, largest premultiplied difference ${result.worst.toFixed(1)}`);
      for (const [name, url] of Object.entries(result.urls)) {
        await writeFile(resolve(outDir, `${sample}-${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

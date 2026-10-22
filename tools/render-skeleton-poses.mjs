import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(root, 'samples/full-body-vest');
const outDir = '/opt/cursor/artifacts';
const frameDir = '/tmp/vest-pose-ik';

function ffmpeg(args) {
  return new Promise((done, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done() : reject(new Error(`ffmpeg exited ${code}`)));
  });
}

async function assetMap() {
  const assets = {};
  async function asset(name) {
    const path = resolve(project, 'built', name);
    assets[name] = `data:${name.endsWith('.png') ? 'image/png' : 'application/json'};base64,${(await readFile(path)).toString('base64')}`;
  }
  await asset('layers.json');
  const layers = JSON.parse(await readFile(resolve(project, 'built/layers.json'), 'utf8'));
  await Promise.all(['base', 'hairmask', ...Object.keys(layers.layers)].map(name => asset(`${name}.png`)));
  return assets;
}

async function main() {
  const rig = JSON.parse(await readFile(resolve(project, 'rig.json'), 'utf8'));
  const assets = await assetMap();
  const server = await createServer({
    root, configFile: false, publicDir: false, appType: 'custom', cacheDir: 'node_modules/.vite-skeleton-review',
    optimizeDeps: { noDiscovery: true, entries: [] },
    plugins: [{ name: 'skeleton-review', configureServer(instance) {
      instance.middlewares.use((req, res, next) => {
        if (req.url !== '/__pose_review__') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><body style="margin:0;background:#dedfe5"><canvas id="avatar"></canvas></body></html>');
      });
    } }],
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null, preTransformRequests: false },
    logLevel: 'error',
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 480, height: 1040 }, deviceScaleFactor: 1 });
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/__pose_review__`);
    const pictures = await page.evaluate(async ({ rig, assets }) => {
      const runtime = await import('/packages/runtime/src/index.ts');
      const canvas = document.getElementById('avatar');
      canvas.style.width = '420px';
      canvas.style.height = '980px';
      const avatar = await runtime.createMeshAvatar(canvas, { rig, assets, manual: true, padTop: 0.02, padSide: 0.08 });
      avatar.setAutoIdle(false);
      avatar.setAutoMotion(false);
      const skeleton = runtime.buildSkeleton(rig);
      const restTip = runtime.forwardKinematics(skeleton, runtime.restPose(skeleton)).wristL.tip;
      const labels = ['stand', 'walk', 'sit', 'wave', 'hands on hips', 'arms crossed', 'kneel', 'bow', 'shrug', 'lunge', 'reach', 'elbow limit'];
      const shots = [];
      for (let index = 0; index < labels.length; index++) {
        if (index < runtime.PRESET_NAMES.length) avatar.applyPosePreset(runtime.PRESET_NAMES[index]);
        else if (index === 10) avatar.solveSkeletonIk({ effector: 'handL', target: [restTip[0] - 150, restTip[1] - 220], method: 'ccd' });
        else {
          const pose = runtime.restPose(skeleton);
          pose.joints.elbowL = { swing: -Math.PI, twist: 0.7 };
          pose.joints.kneeL = { swing: 40 * Math.PI / 180, twist: 0.4 };
          avatar.setSkeletonPose(pose);
        }
        avatar.advance(0);
        shots.push([labels[index], canvas.toDataURL('image/png')]);
      }
      const sheet = document.createElement('canvas');
      const columns = 4;
      const cellW = 320;
      const cellH = 640;
      sheet.width = columns * cellW;
      sheet.height = Math.ceil(shots.length / columns) * cellH;
      const ctx = sheet.getContext('2d');
      ctx.fillStyle = '#dedfe5';
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      ctx.fillStyle = '#171b23';
      ctx.font = '20px sans-serif';
      for (let index = 0; index < shots.length; index++) {
        const [label, url] = shots[index];
        const img = new Image();
        img.src = url;
        await img.decode();
        const x = (index % columns) * cellW;
        const y = Math.floor(index / columns) * cellH;
        const scale = Math.min((cellW - 16) / img.width, (cellH - 44) / img.height);
        ctx.fillText(label, x + 12, y + 26);
        ctx.drawImage(img, x + (cellW - img.width * scale) / 2, y + 36, img.width * scale, img.height * scale);
      }
      const requested = runtime.restPose(skeleton);
      requested.joints.elbowL = { swing: -Math.PI, twist: 0.7 };
      requested.joints.kneeL = { swing: 40 * Math.PI / 180, twist: 0.5 };
      requested.joints.shoulderL = { swing: 4, twist: 2 };
      const applied = avatar.setSkeletonPose(requested);
      avatar.advance(0);
      const deg = value => Math.round(value * 180 / Math.PI);
      const rows = ['elbowL', 'kneeL', 'shoulderL'].map(name => {
        const limit = runtime.jointLimits(skeleton).find(joint => joint.name === name);
        return `${name}: requested ${deg(requested.joints[name].swing)}° twist ${deg(requested.joints[name].twist)}° → applied ${deg(applied.joints[name].swing)}° twist ${deg(applied.joints[name].twist)}° (limit ${deg(limit.swingMin)}° to ${deg(limit.swingMax)}°)`;
      });
      const rom = document.createElement('canvas');
      rom.width = 1100;
      rom.height = 980;
      const pen = rom.getContext('2d');
      pen.fillStyle = '#dedfe5';
      pen.fillRect(0, 0, rom.width, rom.height);
      pen.drawImage(canvas, 20, 20, 400, 940);
      pen.fillStyle = '#171b23';
      pen.font = '22px sans-serif';
      pen.fillText('ROM clamp', 450, 48);
      pen.font = '16px sans-serif';
      rows.forEach((row, index) => pen.fillText(row, 450, 100 + index * 36));
      pen.fillText('Elbow and knee twist stay at 0°. A hinge does not spin the painting.', 450, 230);
      pen.fillText('Shoulder swing stops at the abduction limit, not at the requested angle.', 450, 258);
      pen.fillText('AAOS Joint Motion (1965); Greene and Heckman (1994);', 450, 300);
      pen.fillText('Norkin and White, Measurement of Joint Motion, 5th ed. (2016).', 450, 324);
      window.__pose = { avatar, skeleton, restTip };
      return { sheet: sheet.toDataURL('image/png'), rom: rom.toDataURL('image/png') };
    }, { rig, assets });
    if (browserErrors.length) throw new Error(browserErrors.join('\n'));
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'vest_pose_presets.png'), Buffer.from(pictures.sheet.split(',')[1], 'base64'));
    await writeFile(resolve(outDir, 'vest_pose_rom.png'), Buffer.from(pictures.rom.split(',')[1], 'base64'));

    await mkdir(frameDir, { recursive: true });
    await page.evaluate(async () => {
      const runtime = await import('/packages/runtime/src/index.ts');
      window.__pose.avatar.setSkeletonPose(runtime.restPose(window.__pose.skeleton));
      window.__pose.avatar.advance(0);
    });
    const frames = 96;
    for (let i = 0; i < frames; i++) {
      await page.evaluate(({ i, frames }) => {
        const { avatar, restTip } = window.__pose;
        const swing = Math.sin((i / (frames - 1)) * Math.PI);
        avatar.solveSkeletonIk({
          effector: 'handL',
          target: [restTip[0] - 40 - 170 * swing, restTip[1] - 30 - 240 * swing],
          method: 'ccd',
          iterations: 8,
        });
        avatar.advance(0);
      }, { i, frames });
      await page.locator('#avatar').screenshot({ path: resolve(frameDir, `frame-${String(i).padStart(3, '0')}.jpg`), type: 'jpeg', quality: 82 });
    }
    await ffmpeg(['-y', '-framerate', '24', '-i', resolve(frameDir, 'frame-%03d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', resolve(outDir, 'vest_pose_ik.mp4')]);
    console.log('wrote vest_pose_presets.png, vest_pose_rom.png, vest_pose_ik.mp4');
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

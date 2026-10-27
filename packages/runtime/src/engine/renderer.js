import { layerNormals } from '../lighting/normals';
import { DEFAULT_LIGHTING, parseLighting } from '../lighting/settings';
import { TERMINATOR, DETAIL_SCALE, SHADOW_SATURATION, MAX_IRRADIANCE, headRotation } from '../lighting/shading';
import { DropShadow } from '../lighting/shadow';

// A bust eye is about 95px across: 14 base cells (fine cell 7), 32 lash cells (eye cell 3),
// 24 iris cells (ball cell 4) and 24 sprite cells. A full-body face is a small part of the
// picture, so the same pixel cell leaves only a few quads across that eye.
const BUST_CELLS = { base: 14, lash: 32, ball: 24, sprite: 24 };
// The bust sample's eye is about 95px wide. Mouth height, blush, gaze and the extra
// brow/feature offsets were chosen in those pixels.
const BUST_EYE = 95;

function featureSpan(points) {
  if (!points?.length) return 0;
  let min = Infinity, max = -Infinity;
  for (const point of points) {
    if (point[0] < min) min = point[0];
    if (point[0] > max) max = point[0];
  }
  return max - min;
}

function densityCell(span, across, configured) {
  if (!(span > 4)) return configured;
  const needed = span / across;
  // Already as fine as a bust face of this size. Bust rigs never reach this helper.
  if (needed >= configured * 0.9) return configured;
  return Math.max(0.5, needed);
}

/**
 * Extra face grid for a full-body rig whose eyes are small in the picture.
 * Bust rigs, and a full-body face that is already bust-sized, get no change.
 * @param {import('../rig/types').Rig} rig
 */
export function faceDensity(rig) {
  const configured = {
    fine: rig.mesh.fine?.cell ?? rig.mesh.baseCell,
    eye: rig.mesh.eyeCell,
    ball: rig.mesh.eyeBallCell,
    sprite: rig.mesh.spriteCell,
  };
  if (!rig.fullBody) return { region: null, eyeCell: configured.eye, ballCell: configured.ball, spriteCell: configured.sprite, scale: 1 };
  let span = 0;
  for (const eye of rig.eyes ?? []) {
    const width = featureSpan(eye.opening);
    if (width > 4) span = span ? Math.min(span, width) : width;
  }
  if (!span && rig.mouth?.halfLen > 2) span = rig.mouth.halfLen * 2;
  const fineCell = densityCell(span, BUST_CELLS.base, configured.fine);
  const fine = rig.mesh.fine;
  const region = fine && fineCell < configured.fine
    ? { x0: fine.x0, x1: fine.x1, y0: fine.y0, y1: fine.y1, cell: fineCell }
    : null;
  // A bust-sized eye keeps the authored pixel distances. A smaller full-body eye
  // shrinks them so a blink-sized move stays a blink, not a shove across the face.
  const scale = span > 4 && span / BUST_EYE < 0.9 ? span / BUST_EYE : 1;
  return {
    region,
    eyeCell: densityCell(span, BUST_CELLS.lash, configured.eye),
    ballCell: densityCell(span, BUST_CELLS.ball, configured.ball),
    spriteCell: densityCell(span, BUST_CELLS.sprite, configured.sprite),
    scale,
  };
}

// How far a procedural mouth may extend, in source px from the mouth centre.
// Down stops inside the jaw ellipse. Up stops short of the nose.
function mouthFit(rig) {
  const mouth = rig.mouth;
  if (!mouth) return [8, 4];
  const jaw = rig.face?.jaw;
  const nose = rig.face?.nose;
  const jawBottom = jaw
    ? Math.min(jaw.cy + jaw.ry, Array.isArray(jaw.band) ? jaw.band[1] : jaw.cy + jaw.ry)
    : mouth.cy + mouth.halfLen * 2;
  const down = Math.max(mouth.halfLen * 0.5, jawBottom - mouth.cy - 0.5);
  const noseBottom = nose ? nose.cy + nose.ry * 0.5 : mouth.cy - mouth.halfLen;
  const up = Math.max(mouth.halfLen * 0.25, mouth.cy - noseBottom - 0.3);
  return [down, up];
}

/** @param {ReturnType<import('./rig.js').createRig>} engine
 * @param {import('../rig/types').Rig} rig */
export function createRenderer(engine, rig) {
  const { IMG, EYES, MOUTH, CHEEKS } = engine;
  // the eyelid mask stops short of the brow; without a brow it keeps to just above the opening
  const browY = rig.face?.brow?.cy ?? 1e4;
  const faceScale = faceDensity(rig).scale;
  const [mouthDown, mouthUp] = mouthFit(rig);
  // WebGL2 renderer: textured grid meshes whose vertices are deformed on the CPU,
  // plus a fragment-shader pass for eyelids, eye balls, mouth and blush on the base layer.


  const VS = `#version 300 es
  in vec2 aPos; in vec2 aUv;
  uniform vec2 uScale; uniform vec2 uOffset;
  out vec2 vUv;
  void main() { vUv = aUv; gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0); }`;

  const FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uTex;
  uniform vec4 uRect;        // layer rect in source px
  uniform int uFace;
  uniform float uAlpha;
  uniform vec4 uEyeBox[2];   // x0, x1, brow centre y (face.brow.cy), -
  uniform float uEyeTop[48]; // 2 eyes x EYE_N samples
  uniform float uEyeBot[48];
  uniform vec4 uEyeState[2]; // open, smile, ballX(px), ballY(px)
  uniform vec4 uMouth;       // cx, cy, angle, halfLen
  uniform vec4 uMouthState;  // open, form, bow, -
  uniform vec4 uCheeks;      // x0, y0, x1, y1
  uniform float uCheek;
  uniform float uFaceScale; // 1 on a bust; smaller when a full-body eye is a small part of the picture
  uniform vec2 uMouthFit;   // max t below the mouth centre, max -t above it, source px

  const int EYE_N = 24;
  float crv(int e, bool top, float u) {
    float f = clamp(u, 0.0, 1.0) * float(EYE_N - 1);
    int i = min(int(floor(f)), EYE_N - 2);
    float t = f - float(i);
    int k = e * EYE_N + i;
    return top ? mix(uEyeTop[k], uEyeTop[k + 1], t) : mix(uEyeBot[k], uEyeBot[k + 1], t);
  }

  // Upper lid line and lower lid line of eye e at column u, for the current open/smile state.
  // Must match eyeLids() in rig.js, which moves the lash meshes to the same lines.
  // Must match eyeLidsRaw() / eyeLids() in rig.js.
  vec2 eyeLidsRaw(int e, float u) {
    u = clamp(u, 0.0, 1.0);
    vec4 st = uEyeState[e];
    float top = crv(e, true, u), bot = crv(e, false, u);
    float b = 1.0 - st.x, smile = st.y, hump = 4.0 * u * (1.0 - u);
    float H = crv(e, false, 0.5) - crv(e, true, 0.5);
    float arc = mix(uEyeTop[e * EYE_N], uEyeTop[e * EYE_N + EYE_N - 1], u) - 0.3 * H * hump;
    float closed = max(top, bot + 1.0 + (arc - bot - 1.0) * smile);
    return vec2((closed - top) * max(b, -0.07), b > 0.0 ? (closed - bot) * b * smile : 0.0);
  }

  vec2 eyeLids(int e, float u, float top, float bot) {
    vec4 box = uEyeBox[e];
    float du = 5.0 / (box.y - box.x);
    vec2 raw = eyeLidsRaw(e, u);
    vec2 d = (eyeLidsRaw(e, u - 2.0 * du) + 2.0 * eyeLidsRaw(e, u - du) + 3.0 * raw
            + 2.0 * eyeLidsRaw(e, u + du) + eyeLidsRaw(e, u + 2.0 * du)) / 9.0;
    // for hiding the ball take whichever closes more: the smoothed lash can sit a little
    // above the raw lid near the corners, and the gap must show lid skin, not eye white
    return vec2(top + max(d.x, raw.x), bot + min(d.y, raw.y));
  }

  vec4 texAt(vec2 p) { return texture(uTex, (p - uRect.xy) / uRect.zw); }

  // Eye white + iris layer: shown only between the lids (the lids cover it, it never squashes);
  // the iris slides inside the opening for the gaze.
  vec4 eyeBall(int e, vec2 p) {
    vec4 box = uEyeBox[e]; vec4 st = uEyeState[e];
    float u = clamp((p.x - box.x) / (box.y - box.x), 0.0, 1.0);
    float top = crv(e, true, u), bot = crv(e, false, u);
    vec2 lids = eyeLids(e, u, top, bot);
    float v = clamp((p.y - top) / max(bot - top, 1.0), 0.0, 1.0);
    float w = sqrt(4.0 * u * (1.0 - u)) * sqrt(4.0 * v * (1.0 - v));
    vec4 c = texAt(p - vec2(st.z, st.w) * w);
      // the lash covers ~2px of the ball's upper edge, so the cut can sit under it (no seam)
    return c * smoothstep(lids.x - 1.0, lids.x + 0.5, p.y) * (1.0 - smoothstep(lids.y - 0.9, lids.y + 0.6, p.y));
  }

  vec3 mouthLip(vec2 d, vec2 n) {
    vec3 best = vec3(0.46, 0.12, 0.14);
    float bestS = 0.18;
    for (int i = -4; i <= 4; i++) {
      vec3 c = texAt(uMouth.xy + n * float(i) * 0.55 + d * float(i) * 0.35).rgb;
      float mx = max(c.r, max(c.g, c.b));
      float mn = min(c.r, min(c.g, c.b));
      float score = (mx - mn) + c.r * 0.35 - c.b * 0.15;
      if (score > bestS) { bestS = score; best = c; }
    }
    return best;
  }

  vec3 mouthSkin(vec2 d, vec2 n) {
    vec3 best = vec3(0.87, 0.72, 0.66);
    float bestS = 0.0;
    vec2 q0 = uMouth.xy - d * uMouth.w * 1.85;
    vec2 q1 = uMouth.xy + d * uMouth.w * 1.85;
    vec2 q2 = uMouth.xy - d * uMouth.w * 1.35 - n * uMouth.w * 0.55;
    vec2 q3 = uMouth.xy + d * uMouth.w * 1.35 - n * uMouth.w * 0.55;
    for (int i = 0; i < 4; i++) {
      vec2 q = i == 0 ? q0 : i == 1 ? q1 : i == 2 ? q2 : q3;
      vec3 c = texAt(q).rgb;
      float luma = dot(c, vec3(0.22, 0.68, 0.10));
      float mx = max(c.r, max(c.g, c.b));
      float mn = min(c.r, min(c.g, c.b));
      float score = luma - (mx - mn) * 1.1;
      if (luma > 0.30 && luma < 0.96 && score > bestS) { bestS = score; best = c; }
    }
    return best;
  }

  // A full-body face keeps the bust aperture in mouth-length units, not in bust
  // pixels. Scaling 20px by a 6px eye collapses the hole inside its own feather.
  // Lip and skin colours come from the picture. The edge is about one screen pixel,
  // so a zoomed face redraws the mouth sharply instead of enlarging source texels.
  vec4 mouthVector(vec4 base, vec2 d, vec2 n, float open, float s, float t, float form, float aa) {
    float unit = max(uMouth.w, 1.0);
    float down = max(uMouthFit.x, unit * 0.45);
    float upFit = max(uMouthFit.y, unit * 0.2);
    float wf = mix(0.96, form < 0.0 ? 1.08 : 0.58, abs(form));
    float k = 1.0 - (s / wf) * (s / wf);
    float line = uMouthState.z * (1.0 - clamp(s * s, 0.0, 1.0));
    float hk = k > 0.0 ? pow(k, mix(0.55, form < 0.0 ? 0.38 : 0.92, abs(form))) : 0.0;
    float rad = length(vec2(s / 1.30, (t - line * 0.25) / (unit * 0.95)));
    if (rad > 1.35 && abs(s) > wf + 0.25) return base;

    float openAmt = clamp(open, 0.0, 1.0);
    float tall = mix(1.12, form < 0.0 ? 0.62 : 1.30, abs(form));
    float gapH = min(unit * tall, down * 0.74);
    float lipUpT = min(unit * 0.28, upFit * 0.5);
    float lipLoT = min(unit * 0.36, down * 0.22);
    float rise = min(unit * (0.04 + openAmt * 0.24 * hk), upFit * 0.7);
    float up = line - rise;
    float lo = min(line + openAmt * gapH * hk, down - lipLoT * 0.35);
    float pinch = mix(0.22, 1.0, hk);
    float loLip = min(lo + lipLoT * pinch, down);
    float upLip = max(up - lipUpT * pinch, -upFit);

    vec3 skin = mouthSkin(d, n);
    vec3 lip = mouthLip(d, n);
    float erase = (1.0 - smoothstep(0.72, 1.12, rad)) * smoothstep(0.04, 0.20, openAmt);
    vec4 c = base;
    c.rgb = mix(c.rgb, skin, clamp(erase, 0.0, 1.0));

    float side = 1.0 - smoothstep(wf * 0.88, wf * 1.06, abs(s));
    float lower = smoothstep(lo - aa, lo + aa, t) * (1.0 - smoothstep(loLip - aa, loLip + aa, t)) * side;
    float upper = smoothstep(upLip - aa, upLip + aa, t) * (1.0 - smoothstep(up - aa, up + aa, t)) * side;
    float loMid = clamp((t - lo) / max(loLip - lo, aa), 0.0, 1.0);
    float upMid = clamp((up - t) / max(up - upLip, aa), 0.0, 1.0);
    vec3 loCol = mix(lip * vec3(0.55, 0.38, 0.40), mix(lip, skin, 0.22), smoothstep(0.1, 0.7, loMid));
    float gloss = exp(-((loMid - 0.62) * (loMid - 0.62)) * 8.0) * side;
    loCol = mix(loCol, mix(lip, vec3(1.0, 0.92, 0.90), 0.4), gloss * 0.35);
    vec3 upCol = mix(lip * vec3(0.48, 0.32, 0.34), lip, smoothstep(0.15, 0.85, upMid));
    c.rgb = mix(c.rgb, loCol, clamp(lower, 0.0, 1.0));
    c.rgb = mix(c.rgb, upCol, clamp(upper, 0.0, 1.0));

    float gap = 0.0;
    if (k > 0.0) gap = smoothstep(up - aa, up + aa, t) * (1.0 - smoothstep(lo - aa, lo + aa, t)) * smoothstep(0.0, 0.08, k);
    float tv = clamp((t - up) / max(lo - up, aa), 0.0, 1.0);
    vec3 inside = mix(vec3(0.05, 0.012, 0.018), lip * vec3(0.22, 0.08, 0.09), 0.65);
    inside = mix(inside, inside * vec3(1.25, 1.05, 1.0), tv);
    float tongue = smoothstep(0.50, 0.78, tv) * (1.0 - smoothstep(0.30, 0.78, abs(s) / max(wf, 0.2))) * smoothstep(0.4, 0.7, openAmt);
    inside = mix(inside, mix(lip, vec3(0.86, 0.40, 0.42), 0.62), tongue);
    float teeth = (1.0 - smoothstep(0.06, 0.20, tv)) * smoothstep(0.32, 0.55, openAmt) * (1.0 - smoothstep(0.42, 0.80, abs(s) / max(wf, 0.2)));
    inside = mix(inside, vec3(0.97, 0.95, 0.92), teeth);
    float rimIn = smoothstep(0.0, 0.16, tv) * (1.0 - smoothstep(0.05, 0.22, tv)) + smoothstep(0.72, 0.90, tv) * (1.0 - smoothstep(0.90, 1.0, tv));
    inside = mix(inside, lip * vec3(0.32, 0.14, 0.15), clamp(rimIn, 0.0, 1.0) * 0.85);
    c.rgb = mix(c.rgb, inside, clamp(gap, 0.0, 1.0));
    return c;
  }

  vec4 mouth(vec2 p, vec4 base) {
    float open = uMouthState.x;
    if (open < 0.01) return base;
    vec2 d = vec2(cos(uMouth.z), sin(uMouth.z)), n = vec2(-d.y, d.x);
    vec2 r = p - uMouth.xy;
    float s = dot(r, d) / uMouth.w, t = dot(r, n);
    float form = uMouthState.y;                       // -1 wide "i" .. +1 round "o"
    // One screen pixel, in source px. Computed before any per-pixel return so the
    // derivative stays valid across the face mesh.
    float aa = clamp(max(fwidth(t), abs(fwidth(s)) * uMouth.w) * 1.15, 0.02, max(uMouth.w * 0.18, 0.04));
    if (uFaceScale > 0.9) {
      float wf = mix(0.78, 0.46, clamp(form * 0.5 + 0.5, 0.0, 1.0));
      float k = 1.0 - (s / wf) * (s / wf);
      if (k <= 0.0) return base;
      float line = uMouthState.z * (1.0 - s * s);
      float hk = pow(k, mix(0.55, 0.85, clamp(form, 0.0, 1.0)));
      float px = max(uFaceScale, 0.05);
      float H = mix(20.0, 26.0, clamp(form, 0.0, 1.0)) * px;
      float up = line - (0.6 + open * 2.5 * hk) * px;
      float lo = line + open * H * hk;
      float cov = smoothstep(-0.7, 0.7, t - up) * smoothstep(-0.7, 0.7, lo - t);
      if (cov <= 0.0) return base;
      float tv = clamp((t - up) / max(lo - up, 1.0), 0.0, 1.0);
      vec3 col = mix(vec3(0.24, 0.05, 0.08), vec3(0.48, 0.15, 0.19), tv);
      float tongue = smoothstep(0.5, 0.78, tv) * (1.0 - smoothstep(0.45, 0.8, abs(s) / wf));
      col = mix(col, vec3(0.86, 0.44, 0.47), tongue * 0.9);
      float teeth = (1.0 - smoothstep(0.12, 0.22, tv)) * smoothstep(0.25, 0.45, open) * (1.0 - smoothstep(0.55, 0.85, abs(s) / wf));
      col = mix(col, vec3(0.99, 0.96, 0.94), teeth);
      float rim = 1.0 - smoothstep(0.6, 1.8, lo - t);
      col = mix(col, vec3(0.36, 0.09, 0.11), rim * 0.85);
      return vec4(mix(base.rgb, col, cov), 1.0);
    }
    if (abs(s) > 1.7 || t < -uMouthFit.y - 2.0 || t > uMouthFit.x + 2.0) return base;
    return mouthVector(base, d, n, open, s, t, form, aa);
  }

  // Small full-body eyes have no closed-eye drawing. Sliding the lash mesh down squashes
  // brow and temple pixels from that cut-out across the eye. The upper lid comes down to
  // the same line that hides the ball (eyeLids), so above that line the opening is skin and
  // below it the eye still shows. The skin runs, per column, from the colour just above
  // the opening to the colour just below it, and the edges fade over a few pixels. One
  // lash arc rides the lid edge and settles on a line that dips in the middle when closed.
  // A bust (uFaceScale 1) returns the base unchanged.
  float lidFeather(float H) { return clamp(H * 0.2, 1.5, 3.0); }

  vec4 paintClosedEye(int e, vec2 p, vec4 base) {
    if (uFaceScale > 0.9) return base;
    float close = clamp(1.0 - uEyeState[e].x, 0.0, 1.0);
    if (close < 0.01) return base;
    vec4 box = uEyeBox[e];
    float span = box.y - box.x;
    if (span < 2.0) return base;
    float u = (p.x - box.x) / span;
    float uf = 2.0 / span;
    if (u < -uf || u > 1.0 + uf) return base;
    float uu = clamp(u, 0.0, 1.0);
    float top = crv(e, true, uu), bot = crv(e, false, uu);
    float H = max(bot - top, 1.0);
    float F = lidFeather(H);
    vec2 lids = eyeLids(e, uu, top, bot);
    // the lower edge is the lid line while it is inside the opening, and the lower lid,
    // feathered like the rest, once the eye is shut
    float shut = smoothstep(0.8, 1.0, close);
    float edgeW = mix(0.6, F, shut);
    float side = smoothstep(-uf, uf, u) * (1.0 - smoothstep(1.0 - uf, 1.0 + uf, u));
    float vert = smoothstep(top - F, top + 0.5, p.y) * (1.0 - smoothstep(lids.x - edgeW, lids.x + edgeW, p.y));
    float cover = side * vert * smoothstep(0.0, 0.15, close);
    float smile = clamp(uEyeState[e].y, 0.0, 1.0);
    float hump = 4.0 * u * (1.0 - u);
    float rest = mix(top, bot, 0.46) + H * (0.08 - 0.28 * smile) * hump;
    float lid = mix(lids.x, rest, shut);
    float thick = max(1.25, H * 0.05);
    float taper = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.88, 1.0, u));
    float lash = exp(-((p.y - lid) * (p.y - lid)) / (thick * thick)) * smoothstep(0.0, 0.3, close) * side * taper;
    if (cover <= 0.001 && lash <= 0.001) return base;
    float off = max(2.0, H * 0.2);
    float x = clamp(p.x, box.x, box.y);
    vec3 above = texAt(vec2(x, top - off)).rgb;
    vec3 below = texAt(vec2(x, bot + off)).rgb;
    vec3 lum = vec3(0.2126, 0.7152, 0.0722);
    if (dot(below, lum) < 0.22) below = texAt(vec2(x, bot + off + H)).rgb;
    if (dot(above, lum) < 0.22) above = below;
    if (dot(below, lum) < 0.22) below = above;
    vec3 skin = mix(above, below, smoothstep(top, bot, p.y));
    vec4 c = base;
    c.rgb = mix(c.rgb, skin, cover);
    // A faint shadow under the lid line: darkest at the line, back to skin about half the
    // eye height above it. The tint is the skin's own hue, so the shade stays skin.
    float shadeUp = (1.0 - smoothstep(lid - 0.5, lid + thick, p.y)) * exp(-max(lid - p.y, 0.0) / max(H * 0.45, 1.5));
    float shade = 0.35 * shadeUp * side * smoothstep(0.0, 0.4, close) * (0.4 + 0.6 * taper);
    vec3 tint = 0.82 * skin / max(max(skin.r, max(skin.g, skin.b)), 0.05);
    c.rgb = mix(c.rgb, c.rgb * tint, shade * c.a);
    vec3 ink = vec3(0.08, 0.045, 0.035) * max(c.a, cover);
    c.rgb = mix(c.rgb, ink, clamp(lash, 0.0, 0.98));
    return c;
  }

  // The lash cut-out also holds the brow. Fading the whole layer would erase it, and
  // sliding the mesh would smear it. Hide only the open-eye ink the coming-down lid
  // covers: the whole upper lash above the opening and, once the eye is shut, the lower
  // lash under it. The edges fade like the painted lid.
  vec4 maskEyePart(int e, vec2 p, vec4 c) {
    if (uFaceScale > 0.9) return c;
    float close = clamp(1.0 - uEyeState[e].x, 0.0, 1.0);
    // a clear pixel can still receive the upper lash sliding down below, so it goes on
    if (close < 0.01) return c;
    vec4 box = uEyeBox[e];
    float span = box.y - box.x;
    if (span < 2.0) return c;
    // sizes come from the middle of the eye: near the corners the opening is a point
    float Hm = max(crv(e, false, 0.5) - crv(e, true, 0.5), 1.0);
    float F = lidFeather(Hm);
    float u = (p.x - box.x) / span;
    float uf = 2.0 / span;
    // the side and top edges fade over a few pixels more, so the skin under the lash meets
    // what is left of the cut-out without a visible rim; the top fade still stops short of
    // the brow
    float soft = clamp(Hm * 0.3, 2.0, 5.0);
    float us = soft / span;
    if (u < -0.04 - uf - 3.0 * us || u > 1.04 + uf + 3.0 * us) return c;
    float uu = clamp(u, 0.0, 1.0);
    float top = crv(e, true, uu), bot = crv(e, false, uu);
    vec2 lids = eyeLids(e, uu, top, bot);
    float shut = smoothstep(0.8, 1.0, close);
    float edgeW = mix(0.6, F, shut);
    // A thick upper lash reaches well above the opening. The brow sits further up and is
    // left as drawn: the hidden band stops halfway to the brow centre line (box.z).
    float above = max(top - max(3.0, Hm * 0.75), min(top - 3.0, mix(box.z, top, 0.5)));
    // shut, the band reaches past the lower lash's tail, which would else show as a faint arc
    float below = mix(lids.x, max(lids.x, bot + max(3.0, Hm * 0.65)), shut);
    float side = smoothstep(-0.02 - uf - us, 0.03 + 0.5 * us, u) * (1.0 - smoothstep(0.97 - 0.5 * us, 1.02 + uf + us, u));
    float inside = smoothstep(max(above - F - soft, mix(box.z, top, 0.5) - F), above + 0.8, p.y) * (1.0 - smoothstep(below - edgeW, below + edgeW, p.y));
    // shut, the lash's flick past the outer corner goes too (the half-shut eye keeps it);
    // eye 0 is the left one in the picture, so its outer corner is at u = 0
    float sideW = e == 0
      ? smoothstep(-0.02 - uf - 3.0 * us, 0.03 - us, u) * (1.0 - smoothstep(0.97 - 0.5 * us, 1.02 + uf + us, u))
      : smoothstep(-0.02 - uf - us, 0.03 + 0.5 * us, u) * (1.0 - smoothstep(0.97 + us, 1.02 + uf + 3.0 * us, u));
    vec4 hidden = c * (1.0 - inside * mix(side, sideW, shut) * smoothstep(0.0, 0.15, close));
    // While the eye is half shut, the upper lash rides the coming-down lid: the drawn lash
    // band just above the opening is shown again, moved down by how far the lid has come.
    // It fades out as the eye shuts, where the painted lid takes over.
    float drop = lids.x - top;
    // both eyes draw the same lash thickness, from the smaller opening: sized per eye, the
    // taller eye's lash came out darker
    float Ho = max(crv(1 - e, false, 0.5) - crv(1 - e, true, 0.5), 1.0);
    float lashH = max(2.0, min(Hm, Ho) * 0.22);
    // the ink's bottom (the opening's top line) lands on the lid edge, over the ball's cut
    float ys = p.y - drop - 0.5;
    // solid where it meets the lid, thinning out upward like the open eye's lash
    float band = smoothstep(top - lashH - 1.0, top - 0.4 * lashH, ys) * (1.0 - smoothstep(top + 0.5, top + 1.5, ys));
    float ride = band * side * smoothstep(0.5, 1.5, drop) * (1.0 - shut);
    if (ride <= 0.001) return hidden;
    vec4 lash = texAt(vec2(p.x, ys)) * ride;
    return lash + hidden * (1.0 - lash.a);
  }

  void main() {
    vec2 p = uRect.xy + vUv * uRect.zw;
    vec4 c;
    if (uFace == 1) {
      c = paintClosedEye(1, p, paintClosedEye(0, p, mouth(p, texAt(p))));
      vec2 blushA = vec2(48.0, 22.0) * uFaceScale, blushB = vec2(40.0, 20.0) * uFaceScale;
      float blush = exp(-dot((p - uCheeks.xy) / blushA, (p - uCheeks.xy) / blushA))
                  + exp(-dot((p - uCheeks.zw) / blushB, (p - uCheeks.zw) / blushB));
      c.rgb = mix(c.rgb, c.rgb * vec3(1.0, 0.62, 0.64) , clamp(blush * uCheek * 0.55, 0.0, 1.0) * c.a);
    } else if (uFace == 2 || uFace == 3) {
      c = eyeBall(uFace - 2, p);
    } else if (uFace == 4 || uFace == 5) {
      c = maskEyePart(uFace - 4, p, texAt(p));
    } else {
      c = texAt(p);
    }
    outColor = c * uAlpha;
  }`;

  // Compile only when lighting is first enabled. The original off program is untouched.
  const LIGHT_VS = VS.replace('out vec2 vUv;', 'in float aHeadWeight; out float vHeadWeight; out vec2 vScreen; out vec2 vUv;')
    .replace('vUv = aUv;', 'vHeadWeight = aHeadWeight; vScreen = vec2((aPos.x * uScale.x + uOffset.x + 1.0) * 0.5, (1.0 - aPos.y * uScale.y - uOffset.y) * 0.5); vUv = aUv;');
  const LIGHT_FS = FS.replace('uniform sampler2D uTex;', `uniform sampler2D uTex;
    uniform sampler2D uNormal; in float vHeadWeight; in vec2 vScreen;
    uniform mat3 uHeadRotation; uniform vec3 uLight; uniform vec3 uLightColor; uniform vec3 uAmbientColor;
    uniform vec4 uLighting; uniform vec4 uSurface; uniform float uAspect; uniform int uCel;`)
    .replace('outColor = c * uAlpha;', `
      // RG hold the smooth surface normal, BA the painting's relief (see lighting/normals.ts).
      vec4 encoded = texture(uNormal, vUv);
      vec2 base = encoded.rg * 2.0 - 1.0;
      vec3 n = vec3(base, sqrt(max(0.0, 1.0 - dot(base, base))));
      n = normalize(n + vec3((encoded.ba * 2.0 - 1.0) * uSurface.w * ${DETAIL_SCALE.toFixed(3)}, 0.0));
      n = normalize(mix(n, uHeadRotation * n, vHeadWeight));
      vec2 toLight = (uLight.xy - vScreen) * vec2(uAspect, 1.0);
      vec3 light = normalize(vec3(toLight, uLight.z));
      float ndl = dot(n, light);
      float diffuse;
      if (uCel == 1) {
        float w = 0.01 + uSurface.x * 0.08;
        diffuse = 0.2 + 0.45 * smoothstep(${TERMINATOR.toFixed(3)} - w, ${TERMINATOR.toFixed(3)} + w, ndl) + 0.35 * smoothstep(0.55 - w, 0.55 + w, ndl);
      } else {
        float s = 0.05 + uSurface.x * 0.5;
        diffuse = smoothstep(${TERMINATOR.toFixed(3)} - s, ${TERMINATOR.toFixed(3)} + s, ndl) * (0.35 + 0.65 * max(0.0, ndl));
      }
      float reach = dot(toLight, toLight) / (uLighting.w * uLighting.w);
      float attenuation = 1.0 / (1.0 + reach);
      vec3 radiance = uLightColor * uLighting.y * attenuation;
      // A light close to the surface may brighten a little, but must not bleach painted colours.
      vec3 irradiance = min(uAmbientColor * uLighting.z + radiance * diffuse, vec3(${MAX_IRRADIANCE.toFixed(3)}));
      // Painted shadows are deeper versions of the base colour, not grey: multiply by the colour
      // itself as the surface turns away from the light.
      vec3 albedo = c.rgb / max(c.a, 1e-4);
      float dark = 1.0 - clamp(dot(irradiance, vec3(0.3333)), 0.0, 1.0);
      vec3 shaded = c.rgb * mix(vec3(1.0), albedo, dark * ${SHADOW_SATURATION.toFixed(3)}) * irradiance;
      float specular = pow(max(dot(n, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 60.0) * uSurface.y;
      if (uCel == 1) specular = smoothstep(0.3, 0.35, specular) * uSurface.y;
      vec2 side = length(n.xy) > 0.001 ? normalize(n.xy) : vec2(0.0);
      float rim = pow(1.0 - max(n.z, 0.0), 4.0) * smoothstep(-0.2, 0.7, dot(side, normalize(toLight + vec2(1e-4)))) * uSurface.z;
      shaded += radiance * (specular * max(0.0, ndl) + rim) * c.a;
      // Strength blends between the original painting and the relit result; alpha is unchanged.
      c.rgb = clamp(mix(c.rgb, shaded, uLighting.x), vec3(0.0), vec3(c.a));
      outColor = c * uAlpha;`);

  const LINE_VS = `#version 300 es
  in vec2 aPos; uniform vec2 uScale; uniform vec2 uOffset;
  void main() { gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0); gl_PointSize = 7.0; }`;
  const LINE_FS = `#version 300 es
  precision mediump float; uniform vec4 uColor; out vec4 o; void main() { o = uColor; }`;

  function compile(gl, vs, fs) {
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
      gl.deleteShader(sh);
    }
    gl.bindAttribLocation(prog, 0, 'aPos'); gl.bindAttribLocation(prog, 1, 'aUv'); gl.bindAttribLocation(prog, 2, 'aHeadWeight');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i).name.replace('[0]', '');
      u[name] = gl.getUniformLocation(prog, name);
    }
    return { prog, u };
  }

  // Grid lines along one axis: `cell` spacing, `fine.cell` inside [fine.from, fine.to).
  // Optional extra intervals (elbows and knees) use a smaller cell. With none, the
  // spacing matches the single fine rectangle.
  function axis(start, len, cell, fine, extra = null) {
    const out = [start];
    let v = start;
    while (v < start + len - 0.5) {
      let c = fine && v >= fine.from && v < fine.to ? fine.cell : cell;
      if (extra) for (let i = 0; i < extra.length; i++) {
        const region = extra[i];
        if (v >= region.from && v < region.to && region.cell < c) c = region.cell;
      }
      v = Math.min(start + len, v + c);
      out.push(v);
    }
    return out;
  }

  // Grid mesh over a layer rect (optionally denser inside `fine`); cells that are fully
  // transparent are dropped. `regions` are extra dense rectangles, used around hinges.
  function buildGrid(rect, cell, alpha, alphaW, fine = null, regions = null) {
    const [rx, ry, rw, rh] = rect;
    const extraX = regions && regions.map(region => ({ from: region.x0, to: region.x1, cell: region.cell }));
    const extraY = regions && regions.map(region => ({ from: region.y0, to: region.y1, cell: region.cell }));
    const xs = axis(rx, rw, cell, fine && { from: fine.x0, to: fine.x1, cell: fine.cell }, extraX);
    const ys = axis(ry, rh, cell, fine && { from: fine.y0, to: fine.y1, cell: fine.cell }, extraY);
    const cols = xs.length - 1, rows = ys.length - 1;
    const nv = (cols + 1) * (rows + 1);
    const rest = new Float32Array(nv * 2), uv = new Float32Array(nv * 2);
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      rest[k * 2] = xs[i]; rest[k * 2 + 1] = ys[j];
      uv[k * 2] = (xs[i] - rx) / rw; uv[k * 2 + 1] = (ys[j] - ry) / rh;
    }
    const tris = [], lines = [];
    const alphaH = alpha.length / alphaW;
    // alpha may be a 1x1 stand-in (fully opaque quad)
    const ax = alphaW === 1 ? 0 : 1;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x0 = Math.floor(xs[i] - rx) * ax - 2, x1 = Math.ceil(xs[i + 1] - rx) * ax + 2;
      const y0 = Math.floor(ys[j] - ry) * ax - 2, y1 = Math.ceil(ys[j + 1] - ry) * ax + 2;
      let any = false;
      for (let y = Math.max(0, y0); y < Math.min(alphaH, y1) && !any; y += 1)
        for (let x = Math.max(0, x0); x < Math.min(alphaW, x1); x += 1)
          if (alpha[y * alphaW + x] > 3) { any = true; break; }
      if (!any) continue;
      const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
      tris.push(a, b, c, b, d, c);
      lines.push(a, b, a, c, b, c);
      if (i === cols - 1) lines.push(b, d);
      if (j === rows - 1) lines.push(c, d);
    }
    return { rect, cols, rows, rest, uv, pos: new Float32Array(rest), tris: new Uint32Array(tris), lines: new Uint32Array(lines) };
  }

  // Mesh for a rigid cut-out: `cell`-sized squares inside the drawing and `edge`-pixel
  // squares wherever a square holds both drawn and empty pixels, so the triangles follow the
  // outline within `edge` px. All vertices sit on one `edge` lattice. The cut-out moves as one
  // rigid piece, so the T-junctions where the two sizes meet cannot open.
  function buildContourGrid(rect, cell, alpha, alphaW, edge = 2) {
    const [rx, ry, rw, rh] = rect;
    const alphaH = alpha.length / alphaW;
    const opaqueQuad = alphaW === 1;
    // summed-area tables of drawn (alpha > 3) and solid (alpha > 250) pixels
    const W1 = alphaW + 1;
    const drawn = new Int32Array(W1 * (alphaH + 1)), solid = new Int32Array(W1 * (alphaH + 1));
    for (let y = 0; y < alphaH; y++) {
      let rowDrawn = 0, rowSolid = 0;
      for (let x = 0; x < alphaW; x++) {
        const a = alpha[y * alphaW + x];
        rowDrawn += a > 3 ? 1 : 0; rowSolid += a > 250 ? 1 : 0;
        drawn[(y + 1) * W1 + x + 1] = drawn[y * W1 + x + 1] + rowDrawn;
        solid[(y + 1) * W1 + x + 1] = solid[y * W1 + x + 1] + rowSolid;
      }
    }
    const box = (table, x0, y0, x1, y1) => table[y1 * W1 + x1] - table[y0 * W1 + x1] - table[y1 * W1 + x0] + table[y0 * W1 + x0];
    // `any`: a drawn pixel within the square grown by `margin`; `full`: every pixel of the grown square is solid
    function coverage(px0, py0, px1, py1, margin) {
      if (opaqueQuad) return { any: true, full: true };
      const x0 = Math.max(0, px0 - margin), y0 = Math.max(0, py0 - margin);
      const x1 = Math.min(alphaW, px1 + margin), y1 = Math.min(alphaH, py1 + margin);
      if (x1 <= x0 || y1 <= y0) return { any: false, full: false };
      const area = (px1 + margin - (px0 - margin)) * (py1 + margin - (py0 - margin));
      return { any: box(drawn, x0, y0, x1, y1) > 0, full: box(solid, x0, y0, x1, y1) === area };
    }
    const nx = Math.ceil(rw / edge), ny = Math.ceil(rh / edge);
    const k = Math.max(1, Math.round(cell / edge));
    const index = new Map(), rest = [], uv = [], tris = [], lines = [];
    const vertex = (i, j) => {
      const key = j * (nx + 1) + i;
      let v = index.get(key);
      if (v === undefined) {
        v = rest.length / 2;
        const x = rx + Math.min(rw, i * edge), y = ry + Math.min(rh, j * edge);
        rest.push(x, y);
        uv.push((x - rx) / rw, (y - ry) / rh);
        index.set(key, v);
      }
      return v;
    };
    const emit = (i0, j0, i1, j1) => {
      const a = vertex(i0, j0), b = vertex(i1, j0), c = vertex(i0, j1), d = vertex(i1, j1);
      tris.push(a, b, c, b, d, c);
      lines.push(a, b, a, c, b, c, b, d, c, d);
    };
    const px = i => Math.min(rw, i * edge), py = j => Math.min(rh, j * edge);
    for (let J = 0; J < ny; J += k) for (let I = 0; I < nx; I += k) {
      const I1 = Math.min(nx, I + k), J1 = Math.min(ny, J + k);
      const coarse = coverage(px(I), py(J), px(I1), py(J1), 2);
      if (!coarse.any) continue;
      if (coarse.full) { emit(I, J, I1, J1); continue; }
      for (let j = J; j < J1; j++) for (let i = I; i < I1; i++) {
        if (coverage(px(i), py(j), px(i + 1), py(j + 1), 1).any) emit(i, j, i + 1, j + 1);
      }
    }
    const restArray = new Float32Array(rest);
    return { rect, cols: 0, rows: 0, rest: restArray, uv: new Float32Array(uv), pos: new Float32Array(restArray), tris: new Uint32Array(tris), lines: new Uint32Array(lines) };
  }

  class Renderer {
    // padTop / padSide: margin around the image, as a share of its height / width. A negative
    // padTop pushes the top of the image above the canvas (hides a cut-off top edge).
    constructor(canvas, { padTop = 0, padSide = 0, fit = 'contain' } = {}) {
      this.pad = { top: padTop, side: padSide };
      this.fit = fit;
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, alpha: true, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl; this.canvas = canvas;
      this.main = compile(gl, VS, FS);
      this.line = compile(gl, LINE_VS, LINE_FS);
      this.layers = [];
      this.lighting = DEFAULT_LIGHTING;
      this.lightingStats = { normalMs: 0, computedLayers: 0, cachedLayers: 0 };
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    texture(img) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    addLayer(name, img, mesh, opts = {}) {
      const gl = this.gl;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.DYNAMIC_DRAW);
      for (const prog of [this.main, this.line]) {
        const loc = gl.getAttribLocation(prog.prog, 'aPos');
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
      const uvBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
      const uvLoc = gl.getAttribLocation(this.main.prog, 'aUv');
      gl.enableVertexAttribArray(uvLoc); gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
      const triBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.tris, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      const lineBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.lines, gl.STATIC_DRAW);
      const layer = { name, image: img, mesh, tex: this.texture(img), vao, posBuf, uvBuf, triBuf, lineBuf, visible: true, face: !!opts.face, eyeBall: opts.eyeBall, color: opts.color || [1, 1, 1, 1] };
      this.layers.push(layer);
      return layer;
    }

    /** Move a layer under the body or just above it, leaving the eyes and mouth drawings on top. */
    placeLayer(name, phase) {
      const index = this.layers.findIndex(layer => layer.name === name);
      if (index < 0) return;
      const [layer] = this.layers.splice(index, 1);
      if (phase === 'behind') {
        const base = this.layers.findIndex(item => item.name === 'base');
        this.layers.splice(Math.max(0, base), 0, layer);
        return;
      }
      const over = this.layers.findIndex(item => /^(eye|eyes_|mouth_|hair)/.test(item.name));
      if (over < 0) this.layers.push(layer);
      else this.layers.splice(over, 0, layer);
    }

    destroy() {
      const gl = this.gl;
      for (const layer of this.layers) {
        gl.deleteTexture(layer.tex);
        if (layer.normal) gl.deleteTexture(layer.normal);
        if (layer.headBuf) gl.deleteBuffer(layer.headBuf);
        gl.deleteVertexArray(layer.vao);
        for (const buffer of [layer.posBuf, layer.uvBuf, layer.triBuf, layer.lineBuf]) gl.deleteBuffer(buffer);
      }
      gl.deleteProgram(this.main.prog);
      gl.deleteProgram(this.line.prog);
      if (this.lit) gl.deleteProgram(this.lit.prog);
      this.shadow?.destroy();
      this.layers.length = 0;
    }

    setLighting(value) {
      this.lighting = parseLighting({ ...DEFAULT_LIGHTING, ...value }) ?? DEFAULT_LIGHTING;
      if (!this.lighting.enabled) return;
      const gl = this.gl;
      if (!this.lit) this.lit = compile(gl, LIGHT_VS, LIGHT_FS);
      for (const layer of this.layers) {
        if (layer.normal || layer.overlay) continue;
        const data = layerNormals(layer.image, layer.mesh.rect, rig, !/^(eye|mouth)/.test(layer.name));
        this.lightingStats.normalMs += data.ms;
        this.lightingStats[data.computed ? 'computedLayers' : 'cachedLayers']++;
        layer.normal = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, layer.normal);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.width, data.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data.data);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const weights = new Float32Array(layer.mesh.rest.length / 2);
        for (let i = 0; i < weights.length; i++) weights[i] = engine.headWeight(layer.mesh.rest[i * 2], layer.mesh.rest[i * 2 + 1]);
        layer.headBuf = gl.createBuffer(); gl.bindVertexArray(layer.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, layer.headBuf); gl.bufferData(gl.ARRAY_BUFFER, weights, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
      }
      gl.bindVertexArray(null);
      if (this.lighting.shadow && !this.shadow) this.shadow = new DropShadow(gl, compile);
    }

    resize() {
      const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      // Contain anchors the cut-off body to the bottom; cover crops around the image center.
      const s = (this.fit === 'cover' ? Math.max : Math.min)(w / (IMG.w * (1 + 2 * this.pad.side)), h / (IMG.h * (1 + this.pad.top)));
      const ox = (w - IMG.w * s) / 2, oy = (h - IMG.h * s) / (this.fit === 'cover' ? 2 : 1);
      this.scale = [2 * s / w, -2 * s / h];
      this.offset = [-1 + 2 * ox / w, 1 - 2 * oy / h];
      this.pxScale = s; this.pxOff = [ox, oy];
    }

    draw(state) {
      const gl = this.gl;
      this.resize();
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const lit = this.lighting.enabled, shadow = lit && this.lighting.shadow;
      if (shadow) this.shadow.begin(this.canvas.width, this.canvas.height);
      const m = lit ? this.lit : this.main;
      this.current = m;
      gl.useProgram(m.prog);
      if (lit) {
        const light = this.lighting;
        gl.uniform1i(m.u.uNormal, 1);
        gl.uniform3f(m.u.uLight, light.x, light.y, light.z);
        gl.uniform3f(m.u.uLightColor, ((light.color >> 16) & 255) / 255, ((light.color >> 8) & 255) / 255, (light.color & 255) / 255);
        gl.uniform3f(m.u.uAmbientColor, ((light.ambientColor >> 16) & 255) / 255, ((light.ambientColor >> 8) & 255) / 255, (light.ambientColor & 255) / 255);
        gl.uniform4f(m.u.uLighting, light.strength, light.intensity, light.ambient, light.reach);
        gl.uniform4f(m.u.uSurface, light.softness, light.specular, light.rim, light.detail);
        gl.uniform1f(m.u.uAspect, this.canvas.width / this.canvas.height);
        gl.uniform1i(m.u.uCel, light.mode === 'cel' ? 1 : 0);
        gl.uniformMatrix3fv(m.u.uHeadRotation, false, headRotation(state.angleX ?? 0, state.angleY ?? 0, state.angleZ ?? 0, rig.head.maxRoll));
      }
      gl.uniform2fv(m.u.uScale, this.scale); gl.uniform2fv(m.u.uOffset, this.offset);
      gl.uniform1i(m.u.uTex, 0);
      gl.uniform4fv(m.u.uEyeBox, EYES.flatMap(e => [e.x0, e.x1, browY, 0]));
      gl.uniform1fv(m.u.uEyeTop, EYES.flatMap(e => e.top));
      gl.uniform1fv(m.u.uEyeBot, EYES.flatMap(e => e.bot));
      gl.uniform4fv(m.u.uEyeState, state.eyes);
      gl.uniform4f(m.u.uMouth, MOUTH.cx, MOUTH.cy, MOUTH.angle, MOUTH.halfLen);
      gl.uniform4f(m.u.uMouthState, state.mouthOpen, state.mouthForm, MOUTH.bow, 0);
      gl.uniform4f(m.u.uCheeks, CHEEKS[0][0], CHEEKS[0][1], CHEEKS[1][0], CHEEKS[1][1]);
      gl.uniform1f(m.u.uCheek, state.cheek);
      gl.uniform1f(m.u.uFaceScale, faceScale);
      gl.uniform2f(m.u.uMouthFit, mouthDown, mouthUp);
      gl.activeTexture(gl.TEXTURE0);

      for (const L of this.layers) {
        if (!L.visible || L.overlay) continue;
        this.drawLayer(L, L.alpha ?? 1);
      }
      if (this.original && state.originalAlpha > 0) this.drawLayer(this.original, state.originalAlpha);

      if (shadow) this.shadow.composite(this.lighting);

      if (state.showMesh) {
        const l = this.line;
        gl.useProgram(l.prog);
        gl.uniform2fv(l.u.uScale, this.scale); gl.uniform2fv(l.u.uOffset, this.offset);
        for (const L of this.layers) {
          if (!L.visible || L.overlay) continue;
          gl.bindVertexArray(L.vao);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.lineBuf);
          gl.uniform4fv(l.u.uColor, L.color);
          gl.drawElements(gl.LINES, L.mesh.lines.length, gl.UNSIGNED_INT, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.triBuf);
        }
        if (state.joints?.length) this.drawPoints(state.joints);
        gl.bindVertexArray(null);
      }
    }

    drawLayer(L, alpha) {
      const gl = this.gl, m = this.current;
      gl.useProgram(m.prog);
      gl.bindVertexArray(L.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, L.posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, L.mesh.pos);
      if (this.lighting.enabled) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, L.normal); gl.activeTexture(gl.TEXTURE0); }
      gl.bindTexture(gl.TEXTURE_2D, L.tex);
      gl.uniform4fv(m.u.uRect, L.mesh.rect);
      const faceId = L.eyeBall !== undefined ? 2 + L.eyeBall : L.face ? 1 : L.eyeMask !== undefined ? 4 + L.eyeMask : 0;
      gl.uniform1i(m.u.uFace, faceId);
      gl.uniform1f(m.u.uAlpha, alpha);
      gl.drawElements(gl.TRIANGLES, L.mesh.tris.length, gl.UNSIGNED_INT, 0);
    }

    drawPoints(pts) {
      const gl = this.gl, l = this.line;
      if (!this.pointBuf) {
        this.pointBuf = gl.createBuffer();
        this.pointVao = gl.createVertexArray();
        gl.bindVertexArray(this.pointVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
        const loc = gl.getAttribLocation(l.prog, 'aPos');
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
      gl.bindVertexArray(this.pointVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts.flat()), gl.DYNAMIC_DRAW);
      gl.uniform4f(l.u.uColor, 1, 0.85, 0.2, 1);
      gl.drawArrays(gl.POINTS, 0, pts.length);
    }

    setTriangleOrder(name, tris) {
      const layer = this.layers.find(item => item.name === name);
      if (!layer) return;
      const gl = this.gl;
      gl.bindVertexArray(layer.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, layer.triBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tris, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(null);
    }

    // canvas CSS px -> source image px
    toImage(cx, cy) {
      if (!this.pxOff) return null;   // pointer moved before the first frame was drawn
      const dpr = this.canvas.width / this.canvas.clientWidth;
      return [(cx * dpr - this.pxOff[0]) / this.pxScale, (cy * dpr - this.pxOff[1]) / this.pxScale];
    }
  }
  return { Renderer, buildGrid, buildContourGrid };
}

// The interactive 3D room (three.js).  Used by app.js:
//
//   const room = await startRoom({ canvas, base, terminal, terminalTitle, matrixText, theme, onProgress, onHover, onPick, onFrame });
//   room.focus('projects'); room.overview(); room.setTheme('day'); room.setHover('blog'); room.setViewShift(260);
//
// Two ways to show the room (picked automatically):
//  * BAKED (the real look): assets/room/hotspots.json lists baked_day / baked_night. Blender's Cycles already computed
//    lighting, shadows, ambient occlusion and glow into one texture atlas per theme, so the room is drawn UNLIT from
//    that texture and matches the Blender render. Day <-> night cross-fades between the two atlases.
//  * LIVE (preview only): no baked files -> simple real-time lights + shadows.
// Only the monitor terminal and the LED matrix are live (animated canvases).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ---------------------------------------------------------------- config
const HFOV = 48;                                   // horizontal field of view (deg): keeps the room framed on phones too
const EXPOSURE_STOPS = 0.1;                        // match EXPOSURE in blender/blender_room.py
const BAKED_TWEAK = { day: 1.0, night: 1.0 };      // multiply brightness per theme if a baked atlas looks too dark / bright
const GRADE = { contrast: 1.08, saturation: 1.06 };
const BLOOM = { strength: 0.22, radius: 0.55, threshold: 1.2 };
const ROOM_LIFT = 0.02;                            // moves the room up a little (fraction of the screen height)
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const LOW_POWER = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;

// ---------------------------------------------------------------- helpers
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const mixColor = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);

const DEFAULT_MANIFEST = {
  overview: { target: [0.2, 2, 0], camera: [19.9, 17.7, 19.7] },
  sections: {},
  lights: { desk_lamp: [3.1, 2.2, -3.6], screen_glow: [0.9, 2.6, -2.8], matrix_glow: [0.9, 4.05, -3.5] },
  themes: {
    day: { sun_position: [-23.7, 18.5, -4.1], sun_color: [1, 0.98, 0.95] },
    night: { sun_position: [-24.6, 17.2, -3.4], sun_color: [0.6, 0.7, 1] },
  },
  baked: null,
};

// ---------------------------------------------------------------- shared state
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 400);
let renderer, composer = null, bloomPass = null, controls, canvas;
let manifest = DEFAULT_MANIFEST;
let baked = false;
let themeT = 1, themeTarget = 1;                    // 0 = day, 1 = night (animated)
let tween = null, viewShift = 0, viewShiftTarget = 0, paused = false;
let focusedKey = null, hoverKey = null;
let terminal = null, matrix = null;
let cfg = {};
const hot = {};                 // section -> { meshes: [], hover: 0, anchor: Vector3 }
const hotMeshes = [];
const liveMats = [];
const hotAmount = new Map();
const bakeUniforms = { uMap2: { value: null }, uMix: { value: 0 } };
const bakedBySection = {};
let bakedShared = null, bakedGain = 2.5;
let shadowT = -1;

// ---------------------------------------------------------------- canvas textures (live mode + animated screens)
function noiseSpeckle(ctx, w, h, n, a) {
  for (let i = 0; i < n; i++) {
    const v = Math.random() < 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${Math.random() * a})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

function makeWall() {
  const S = 480;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#efeee9'; ctx.fillRect(0, 0, S, S);
  noiseSpeckle(ctx, S, S, 6000, 0.05);
  ctx.fillStyle = 'rgba(120,118,110,0.5)';
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) { ctx.beginPath(); ctx.arc((i + 0.5) * 30, (j + 0.5) * 30, 3.2, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = 'rgba(95,93,86,0.55)'; ctx.lineWidth = 3; ctx.beginPath();
  for (const p of [0, S / 2]) { ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.moveTo(0, p); ctx.lineTo(S, p); }
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 2.4, 1 / 2.4);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.flipY = false;
  return t;
}

function makeTile() {
  const S = 320;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d8d7d2'; ctx.fillRect(0, 0, S, S);
  noiseSpeckle(ctx, S, S, 5000, 0.05);
  ctx.strokeStyle = 'rgba(120,118,110,0.6)'; ctx.lineWidth = 3; ctx.beginPath();
  for (const p of [0, S / 2]) { ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.moveTo(0, p); ctx.lineTo(S, p); }
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 1.6, 1 / 1.6);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.flipY = false;
  return t;
}

// ---------------------------------------------------------------- monitor terminal
function makeTerminal() {
  const W = 1024, H = 578;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 8;
  const lines = cfg.terminal || ['$ hello'];
  const title = (cfg.terminalTitle || 'tty0').toUpperCase();
  const FONT = '30px ui-monospace, Menlo, Consolas, monospace';
  let line = 0, ch = 0, hold = 0, last = 0, dirty = true, blink = true, lastBlink = 0;

  function draw() {
    ctx.fillStyle = '#0f0f0f'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ff5b14'; ctx.fillRect(28, 24, 22, 22);
    ctx.fillStyle = '#8a8985'; ctx.font = '22px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(title, 66, 43);
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(28, 62, W - 56, 2);
    ctx.font = FONT;
    const shown = Math.max(0, line - 11);
    for (let i = shown; i <= line && i < lines.length; i++) {
      const full = i < line ? lines[i] : lines[i].slice(0, ch);
      const y = 112 + (i - shown) * 38;
      const src = lines[i];
      if (src.startsWith('$')) {
        ctx.fillStyle = '#ff5b14'; ctx.fillText('$', 28, y);
        ctx.fillStyle = '#f3f2ee'; ctx.fillText(full.slice(1), 50, y);
      } else {
        ctx.fillStyle = /^(\/\/|#)/.test(src) ? '#6f6e6a' : /(error|fail|panic)/i.test(src) ? '#ff5b14' : '#bdbcb7';
        ctx.fillText(full, 28, y);
      }
      if (i === line && blink) {
        const off = src.startsWith('$') ? 22 : 0;
        ctx.fillStyle = '#ff5b14';
        ctx.fillRect(28 + off + ctx.measureText(src.startsWith('$') ? full.slice(1) : full).width + 6, y - 26, 16, 32);
      }
    }
    tex.needsUpdate = true;
  }
  return {
    texture: tex,
    update(now) {
      if (now - lastBlink > 520) { blink = !blink; lastBlink = now; dirty = true; }
      if (now - last > (REDUCED_MOTION ? 5 : 38)) {
        last = now;
        if (hold > 0) { hold -= 1; if (hold === 0) { line = 0; ch = 0; } dirty = true; }
        else if (line < lines.length) {
          ch += lines[line].startsWith('$') ? 1 : 5;
          if (ch >= lines[line].length) { line += 1; ch = 0; if (line >= lines.length) hold = 110; else if (!lines[line].startsWith('$')) ch = lines[line].length; }
          dirty = true;
        }
      }
      if (dirty) { draw(); dirty = false; }
    },
  };
}

// ---------------------------------------------------------------- 16x16 LED matrix
const FONT3x5 = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', ' ': '000000000000000', '.': '000000000000010', '-': '000000111000000', '!': '010010010000010',
  '_': '000000000000111',
};
const SYMBOLS = [
  ['001111100', '011111110', '111111111', '111111111', '111111111', '111111111', '111111111', '011111110', '001111100'],
  ['000010000', '000111000', '000111000', '001111100', '001111100', '011111110', '011111110', '111111111', '111111111'],
  ['111111111', '111111111', '111111111', '111111111', '111111111', '111111111', '111111111', '111111111', '111111111'],
];

function makeMatrix() {
  const N = 16, P = 24, S = N * P;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 8;
  const text = String(cfg.matrixText || 'HELLO').toUpperCase();
  const cols = [];
  for (const chr of text) {
    const g = FONT3x5[chr] || FONT3x5[' '];
    for (let x = 0; x < 3; x++) { let v = 0; for (let y = 0; y < 5; y++) if (g[y * 3 + x] === '1') v |= 1 << y; cols.push(v); }
    cols.push(0);
  }
  const grid = Array.from({ length: N }, () => new Array(N).fill(0));
  const bars = new Array(8).fill(3);
  let offset = N, step = 0, last = 0;
  const t0 = performance.now();

  function render() {
    ctx.fillStyle = '#0b0b0b'; ctx.fillRect(0, 0, S, S);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      ctx.beginPath(); ctx.arc(x * P + P / 2, y * P + P / 2, P * 0.33, 0, Math.PI * 2);
      if (grid[y][x]) { ctx.shadowColor = '#ff5b14'; ctx.shadowBlur = 10; ctx.fillStyle = '#ff6a26'; }
      else { ctx.shadowBlur = 0; ctx.fillStyle = '#26201c'; }
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    tex.needsUpdate = true;
  }
  function frame(mode) {
    for (const row of grid) row.fill(0);
    if (mode === 0) {
      for (let i = 0; i < cols.length; i++) {
        const x = Math.floor(offset) + i;
        if (x < 0 || x >= N) continue;
        for (let y = 0; y < 5; y++) if (cols[i] & (1 << y)) grid[6 + y][x] = 1;
      }
      offset -= 0.5;
      if (offset < -cols.length) offset = N;
    } else if (mode === 1) {
      for (let b = 0; b < 8; b++) {
        bars[b] = Math.max(1, Math.min(15, bars[b] + Math.round((Math.random() - 0.5) * 6)));
        for (let h = 0; h < bars[b]; h++) { grid[15 - h][b * 2] = 1; grid[15 - h][b * 2 + 1] = 1; }
      }
    } else {
      const sym = SYMBOLS[Math.floor(step / 8) % SYMBOLS.length];
      for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (sym[y][x] === '1') grid[3 + y][3 + x] = 1;
    }
  }
  return {
    texture: tex,
    update(now) {
      if (now - last < (REDUCED_MOTION ? 400 : 100)) return;
      last = now; step += 1;
      frame(Math.floor((now - t0) / 7000) % 3);
      render();
    },
  };
}

// ---------------------------------------------------------------- materials
const SCREEN_MATS = new Set(['screen_tex', 'matrix_tex']);

function styleScreen(m) {
  if (m.name === 'screen_tex') {
    terminal = terminal || makeTerminal();
    m.color.set(0x000000); m.emissive.set(0xffffff); m.emissiveMap = terminal.texture;
    m.userData.emissive = { day: 0.9, night: 1.7 };
  } else {
    matrix = matrix || makeMatrix();
    m.color.set(0x000000); m.emissive.set(0xffffff); m.emissiveMap = matrix.texture;
    m.userData.emissive = { day: 1.0, night: 2.2 };
  }
  m.userData.noHighlight = true;
  m.envMapIntensity = 0;
}

function styleLiveMaterial(m) {          // live (unbaked) preview only: rebuild the look from the material name
  const n = m.name;
  if (n === 'wall_L' || n === 'wall_R') { m.map = makeWall(); m.color.set(0xffffff); m.roughness = 0.92; m.metalness = 0; }
  else if (n === 'tile') { m.map = makeTile(); m.color.set(0xffffff); m.roughness = 0.5; m.metalness = 0; m.userData.env = 0.4; }
  else if (['white', 'grey_l', 'grey_m', 'pot'].includes(n)) { m.roughness = 0.38; m.metalness = 0; m.userData.env = 0.6; }
  else if (n === 'black' || n === 'glass_dark') { m.roughness = 0.35; m.metalness = 0; m.userData.env = 0.8; }
  else if (n === 'rubber') { m.roughness = 0.9; m.metalness = 0; }
  else if (n === 'accent' || n === 'accent_d') { m.roughness = 0.5; m.metalness = 0; m.userData.env = 0.5; }
  else if (n === 'alu') { m.metalness = 0.9; m.roughness = 0.3; m.userData.env = 1.0; }
  else if (n === 'lcd') { m.color.set(0x222a22); m.emissive.set(0xcfe0cc); m.userData.noHighlight = true; m.userData.emissive = { day: 0.8, night: 1.8 }; }
  else if (n === 'lamp_emit') { m.color.set(0x222222); m.emissive.set(0xfff3e0); m.userData.noHighlight = true; m.userData.emissive = { day: 0.7, night: 2.6 }; }
  else if (n === 'led_green') { m.color.set(0x113322); m.emissive.set(0x58ff9a); m.userData.noHighlight = true; m.userData.emissive = { day: 1.6, night: 2.6 }; }
  else if (n === 'led_accent') { m.color.set(0x331100); m.emissive.set(0xff5b14); m.userData.noHighlight = true; m.userData.emissive = { day: 1.6, night: 2.8 }; }
}

function makeBakedMaterial(dayTex) {
  const mat = new THREE.MeshBasicMaterial({ map: dayTex });
  mat.color.setScalar(bakedGain);                                // the atlas was baked at reduced light so it does not clip
  mat.onBeforeCompile = (shader) => {                            // cross-fade between the day and the night atlas
    shader.uniforms.uMap2 = bakeUniforms.uMap2;
    shader.uniforms.uMix = bakeUniforms.uMix;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uMap2;\nuniform float uMix;')
      .replace('#include <map_fragment>', '#ifdef USE_MAP\n vec4 bakeA = texture2D( map, vMapUv );\n vec4 bakeB = texture2D( uMap2, vMapUv );\n diffuseColor *= mix( bakeA, bakeB, uMix );\n#endif');
  };
  mat.customProgramCacheKey = () => 'baked-mix';
  return mat;
}

// ---------------------------------------------------------------- live-mode lights
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 110 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 2.5;
const hemi = new THREE.HemisphereLight(0xffffff, 0x9a978f, 0.65);
const lamp = new THREE.PointLight(0xffd0a0, 0, 9, 2);
const glow = new THREE.PointLight(0xdfe6f5, 0, 7, 2);
const orange = new THREE.PointLight(0xff5b14, 0, 7, 2);
const LIVE = {
  day: { sun: 3.2, hemi: 0.7, lamp: 0, glow: 2, orange: 0, hemiSky: 0xffffff, hemiGround: 0x9a978f },
  night: { sun: 0.45, hemi: 0.12, lamp: 22, glow: 14, orange: 16, hemiSky: 0x2c3350, hemiGround: 0x101010 },
};

function makeGround() {
  if (baked) {                                   // soft contact shadow under the plinth (the room's own shadows are baked in)
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 20, 128, 128, 126);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.5 }));
    m.rotation.x = -Math.PI / 2; m.position.set(0.2, -0.52, 0.2); m.scale.set(14.5, 14.5, 1);
    return m;
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.35 }));
  m.rotation.x = -Math.PI / 2; m.position.y = -0.505; m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- loading
async function loadTexture(url) {
  const t = await new THREE.TextureLoader().loadAsync(url);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

async function loadAll(base, onProgress) {
  const dir = `${base}/assets/room/`;
  try { manifest = { ...DEFAULT_MANIFEST, ...(await (await fetch(dir + 'hotspots.json')).json()) }; }
  catch { console.warn('hotspots.json not found - using defaults'); }

  const gltf = await new GLTFLoader().loadAsync(dir + 'room.glb', (e) => { if (e.lengthComputable) onProgress((e.loaded / e.total) * 0.6); });
  const root = gltf.scene;

  let bakedTex = null;
  if (manifest.baked && manifest.baked.day && manifest.baked.night) {
    try {
      bakedTex = { day: await loadTexture(dir + manifest.baked.day), night: await loadTexture(dir + manifest.baked.night) };
      baked = true;
      bakedGain = manifest.baked.gain ?? 2.5;
    } catch (e) { console.warn('baked atlases could not be loaded - falling back to live lights', e); baked = false; }
  }
  onProgress(0.85);

  root.traverse((o) => {                                     // hotspot groups: custom property "hotspot" on the glTF node
    const sec = o.userData?.hotspot;
    if (!sec) return;
    hot[sec] = hot[sec] || { meshes: [], hover: 0, anchor: new THREE.Vector3() };
    const add = (m) => { if (m.isMesh) { m.userData.section = sec; hot[sec].meshes.push(m); hotMeshes.push(m); } };
    add(o); o.traverse(add);
  });

  if (baked) {
    bakeUniforms.uMap2.value = bakedTex.night;
    bakedShared = makeBakedMaterial(bakedTex.day);
    for (const sec of Object.keys(hot)) bakedBySection[sec] = makeBakedMaterial(bakedTex.day);
    const seen = new Set();
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = false;
      const mats = [].concat(o.material);
      if (mats.some((m) => SCREEN_MATS.has(m.name))) {         // animated screens stay live
        const m = mats[0];
        if (!seen.has(m)) { seen.add(m); styleScreen(m); liveMats.push(m); }
        return;
      }
      o.material = bakedBySection[o.userData.section] || bakedShared;
    });
    sun.visible = hemi.visible = lamp.visible = glow.visible = orange.visible = false;
    renderer.shadowMap.enabled = false;
  } else {
    const seen = new Set();
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) if (!seen.has(m)) { seen.add(m); SCREEN_MATS.has(m.name) ? styleScreen(m) : styleLiveMaterial(m); }
    });
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      const own = o.userData.section;
      const arr = [].concat(o.material).map((m) => {
        const mm = own ? m.clone() : m;
        mm.userData = { ...m.userData };
        liveMats.push(mm);
        return mm;
      });
      o.material = Array.isArray(o.material) ? arr : arr[0];
    });
  }

  scene.add(root);
  scene.add(sun, sun.target, hemi, lamp, glow, orange);
  scene.add(makeGround());

  for (const [k, s] of Object.entries(manifest.sections)) if (hot[k]) hot[k].anchor.copy(v3(s.anchor));
  lamp.position.copy(v3(manifest.lights.desk_lamp));
  glow.position.copy(v3(manifest.lights.screen_glow));
  orange.position.copy(v3(manifest.lights.matrix_glow || [0.9, 4.05, -3.5]));
  renderer.shadowMap.needsUpdate = true;
  onProgress(1);
}

// ---------------------------------------------------------------- theme
function applyThemeFrame() {
  const t = themeT;
  const d = manifest.themes.day, n = manifest.themes.night;
  renderer.toneMappingExposure = Math.pow(2, EXPOSURE_STOPS);

  if (baked) {
    bakeUniforms.uMix.value = t;
    const tweak = lerp(BAKED_TWEAK.day, BAKED_TWEAK.night, t);
    for (const mat of [bakedShared, ...Object.values(bakedBySection)]) {
      const h = mat === bakedShared ? 0 : (hotAmount.get(mat) || 0);
      mat.color.setScalar(bakedGain * tweak * (1 + 0.16 * h));
    }
    if (bloomPass) bloomPass.strength = lerp(BLOOM.strength, BLOOM.strength * 1.6, t);
  } else {
    const L = LIVE;
    sun.intensity = lerp(L.day.sun, L.night.sun, t);
    sun.color.setRGB(...d.sun_color).lerp(new THREE.Color(...n.sun_color), t);
    sun.position.copy(v3(d.sun_position).lerp(v3(n.sun_position), t));
    sun.target.position.set(0, 1, -2);
    hemi.intensity = lerp(L.day.hemi, L.night.hemi, t);
    hemi.color.copy(mixColor(L.day.hemiSky, L.night.hemiSky, t));
    hemi.groundColor.copy(mixColor(L.day.hemiGround, L.night.hemiGround, t));
    lamp.intensity = lerp(L.day.lamp, L.night.lamp, t);
    glow.intensity = lerp(L.day.glow, L.night.glow, t);
    orange.intensity = lerp(L.day.orange, L.night.orange, t);
    if (Math.abs(t - shadowT) > 0.0005) { renderer.shadowMap.needsUpdate = true; shadowT = t; }
  }
  for (const m of liveMats) {
    const e = m.userData?.emissive;
    if (e) m.emissiveIntensity = lerp(e.day, e.night, t);
    if (m.userData?.env !== undefined) m.envMapIntensity = m.userData.env * lerp(1, 0.4, t);
  }
}

// ---------------------------------------------------------------- camera
function moveCamera(toPos, toTarget, ms = 1100) {
  tween = { t: 0, ms: REDUCED_MOTION ? 1 : ms, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toPos, toTarget };
  controls.enabled = false;
}

function resize() {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height)), aspect = w / h;
  renderer.setSize(w, h, false);
  if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
  const vfov = (2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) / aspect) * 180) / Math.PI;
  camera.fov = Math.min(70, Math.max(26, vfov));
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- start
export async function startRoom(opts) {
  cfg = opts;
  canvas = opts.canvas;
  const base = opts.base || '';
  const onProgress = opts.onProgress || (() => {});
  const onHover = opts.onHover || (() => {});
  const onPick = opts.onPick || (() => {});
  const onFrame = opts.onFrame || (() => {});
  themeT = themeTarget = opts.theme === 'day' ? 0 : 1;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: LOW_POWER, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;     // Blender 4.x uses AgX as well
  renderer.toneMappingExposure = Math.pow(2, EXPOSURE_STOPS);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 4;
  controls.maxDistance = 70;

  if (!LOW_POWER) {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });   // MSAA on the HDR target
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
    composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null }, contrast: { value: GRADE.contrast }, saturation: { value: GRADE.saturation } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform float contrast; uniform float saturation; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
          c.rgb = mix(vec3(l), c.rgb, saturation); c.rgb = (c.rgb - 0.5) * contrast + 0.5; gl_FragColor = c; }`,
    }));
  }
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;   // live mode: reflections on metals

  await loadAll(base, onProgress);
  new ResizeObserver(resize).observe(canvas);
  resize();

  // initial camera + limits
  camera.position.copy(v3(manifest.overview.camera));
  controls.target.copy(v3(manifest.overview.target));
  const off = camera.position.clone().sub(controls.target);
  const az = Math.atan2(off.x, off.z);
  controls.minAzimuthAngle = az - 0.75;
  controls.maxAzimuthAngle = az + 0.75;
  controls.update();

  // picking / hover
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(hotMeshes, false)[0];
    return hit ? hit.object.userData.section : null;
  }
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) { const k = pick(e); if (k) onPick(k); }
    down = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || e.buttons) return;
    const k = pick(e);
    if (k !== hoverKey) { hoverKey = k; canvas.style.cursor = k ? 'pointer' : 'grab'; onHover(k, e); }
    else if (k) onHover(k, e);
  });
  canvas.addEventListener('pointerleave', () => { if (hoverKey) { hoverKey = null; onHover(null); } });

  // loop
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = performance.now();

    if (tween) {
      tween.t += (dt * 1000) / tween.ms;
      const k = ease(Math.min(tween.t, 1));
      camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
      if (tween.t >= 1) { tween = null; controls.enabled = true; }
    }
    controls.update();

    const w = canvas.clientWidth, h = canvas.clientHeight;
    viewShift = lerp(viewShift, viewShiftTarget, REDUCED_MOTION ? 1 : 0.1);
    camera.setViewOffset(w, h, viewShift, ROOM_LIFT * h, w, h);

    themeT += Math.sign(themeTarget - themeT) * Math.min(Math.abs(themeTarget - themeT), dt * 1.4);

    for (const [key, hs] of Object.entries(hot)) {
      hs.hover = lerp(hs.hover, hoverKey === key || focusedKey === key ? 1 : 0, 0.15);
      if (baked) hotAmount.set(bakedBySection[key], hs.hover);
      else for (const m of hs.meshes) for (const mat of [].concat(m.material)) {
        if (!mat.userData.noHighlight) mat.emissive.setScalar(hs.hover * 0.16);
      }
    }
    applyThemeFrame();
    if (terminal) terminal.update(now);
    if (matrix) matrix.update(now);

    onFrame((key) => {                                   // screen position of a hotspot anchor (CSS px)
      const hs = hot[key];
      if (!hs) return null;
      tmp.copy(hs.anchor).project(camera);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((tmp.x * 0.5 + 0.5) * w - viewShift), y: r.top + ((-tmp.y * 0.5 + 0.5) * h - ROOM_LIFT * h), visible: tmp.z < 1 };
    });

    if (!paused) { if (composer) composer.render(); else renderer.render(scene, camera); }
  }
  animate();

  return {
    baked,
    sections: () => Object.keys(hot),
    focus(key) {
      const s = manifest.sections[key];
      focusedKey = key;
      if (s) moveCamera(v3(s.camera), v3(s.target));
    },
    overview() {
      focusedKey = null;
      moveCamera(v3(manifest.overview.camera), v3(manifest.overview.target));
    },
    setTheme(name, instant = false) {
      themeTarget = name === 'day' ? 0 : 1;
      if (instant || REDUCED_MOTION) themeT = themeTarget;
    },
    setHover(key) { hoverKey = key; canvas.style.cursor = key ? 'pointer' : 'grab'; },
    setViewShift(px) { viewShiftTarget = px; },
    setPaused(p) { paused = !!p; },
  };
}

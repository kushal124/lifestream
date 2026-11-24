// @ts-check

export const SCENES = 8;

/** @typedef {[number, number, number]} Rgb */

/** @param {number} edge0 @param {number} edge1 @param {number} x */
const smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
/** @param {Rgb} a @param {Rgb} b @param {number} t @returns {Rgb} */
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const disc = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ cx, /** @type {number} */ cy,
  /** @type {number} */ r, soft = 0.01) => 1 - smooth(r - soft, r + soft, Math.hypot(x - cx, y - cy));
const oval = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ cx, /** @type {number} */ cy,
  /** @type {number} */ rx, /** @type {number} */ ry, soft = 0.01) => 1 - smooth(1 - soft / rx, 1 + soft / rx,
  Math.hypot((x - cx) / rx, (y - cy) / ry));
const box = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ x0, /** @type {number} */ y0,
  /** @type {number} */ x1, /** @type {number} */ y1, soft = 0.004) => smooth(x0 - soft, x0 + soft, x)
  * (1 - smooth(x1 - soft, x1 + soft, x)) * smooth(y0 - soft, y0 + soft, y) * (1 - smooth(y1 - soft, y1 + soft, y));
const hash = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ seed) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

/** @type {((x: number, y: number) => Rgb)[]} */
const PAINTERS = [
  (x, y) => {
    let c = mix([150, 132, 116], [86, 74, 66], smooth(0, 1, (x + y) / 2));
    const shoulders = oval(x, y, 0.5, 1.08, 0.46, 0.34, 0.02);
    c = mix(c, mix([62, 70, 84], [40, 46, 58], x), shoulders);
    c = mix(c, [176, 136, 112], (1 - smooth(0.1, 0.13, Math.abs(x - 0.5))) * box(x, y, 0, 0.6, 1, 0.78, 0.02));
    const head = oval(x, y, 0.5, 0.44, 0.19, 0.24, 0.015);
    const light = smooth(0.7, 0, Math.hypot(x - 0.38, y - 0.34));
    c = mix(c, mix([150, 108, 86], [214, 170, 140], light), head);
    c = mix(c, [58, 44, 38], oval(x, y, 0.5, 0.36, 0.215, 0.17, 0.02) * (1 - smooth(0.32, 0.4, y + Math.abs(x - 0.5) * 0.25)));
    return c;
  },
  (x, y) => {
    let c = mix([58, 44, 36], [28, 22, 20], y);
    for (const [cx, cy, r, w] of /** @type {const} */ ([[0.2, 0.22, 0.09, 0.8], [0.52, 0.16, 0.06, 0.6],
      [0.78, 0.3, 0.11, 0.7], [0.36, 0.38, 0.05, 0.5], [0.9, 0.12, 0.05, 0.5]])) {
      c = mix(c, [236, 186, 120], disc(x, y, cx, cy, r, 0.03) * w);
    }
    const table = smooth(0.62, 0.64, y);
    c = mix(c, mix([120, 90, 66], [84, 62, 46], (y - 0.62) * 2.6), table);
    c = mix(c, [40, 30, 24], oval(x, y, 0.58, 0.9, 0.2, 0.04, 0.03) * 0.5);
    c = mix(c, [222, 216, 206], box(x, y, 0.45, 0.74, 0.67, 0.88, 0.006) * oval(x, y, 0.56, 0.74, 0.12, 0.16, 0.01));
    c = mix(c, [222, 216, 206], disc(x, y, 0.7, 0.79, 0.04, 0.006) * (1 - disc(x, y, 0.7, 0.79, 0.022, 0.006)));
    c = mix(c, [226, 222, 214], oval(x, y, 0.56, 0.74, 0.11, 0.03, 0.006));
    c = mix(c, [72, 44, 28], oval(x, y, 0.56, 0.742, 0.09, 0.02, 0.006));
    return c;
  },
  (x, y) => {
    const grain = 0.5 + 0.5 * Math.sin(y * 70 + Math.sin(x * 9) * 2);
    let c = mix([132, 96, 64], [104, 74, 50], grain * 0.6);
    c = mix(c, [40, 30, 24], disc(x, y, 0.53, 0.53, 0.42, 0.06) * 0.35);
    c = mix(c, [232, 230, 226], disc(x, y, 0.5, 0.5, 0.38, 0.01));
    c = mix(c, [210, 208, 204], disc(x, y, 0.5, 0.5, 0.29, 0.01) * (1 - disc(x, y, 0.5, 0.5, 0.27, 0.01)));
    c = mix(c, [196, 150, 82], oval(x, y, 0.44, 0.46, 0.16, 0.11, 0.02));
    c = mix(c, [92, 132, 70], disc(x, y, 0.6, 0.58, 0.09, 0.02));
    c = mix(c, [176, 74, 52], disc(x, y, 0.4, 0.6, 0.05, 0.015));
    c = mix(c, [120, 156, 84], disc(x, y, 0.56, 0.38, 0.045, 0.015));
    return c;
  },
  (x, y) => {
    let c = mix([44, 62, 96], [214, 140, 92], smooth(0.05, 0.62, y));
    const roofs = 0.3 + 0.12 * Math.floor(Math.abs(Math.sin(Math.floor(x * 7) * 12.9)) * 3) / 3;
    const building = smooth(roofs - 0.004, roofs + 0.004, y);
    c = mix(c, [36, 34, 42], building);
    const lit = box((x * 14) % 1, (y * 18) % 1, 0.3, 0.3, 0.7, 0.75, 0.05) * (hash(Math.floor(x * 14), Math.floor(y * 18), 3) > 0.55 ? 1 : 0);
    c = mix(c, [232, 184, 112], lit * building * (1 - smooth(0.66, 0.68, y)) * 0.85);
    c = mix(c, mix([52, 50, 56], [30, 30, 34], (y - 0.7) * 3), smooth(0.69, 0.71, y));
    c = mix(c, [220, 200, 150], box(x, y, 0.46, 0.84, 0.54, 0.86, 0.01) * 0.6);
    return c;
  },
  (x, y) => {
    let c = mix([168, 196, 220], [214, 222, 226], y * 1.6);
    const ground = smooth(0.56, 0.58, y);
    c = mix(c, mix([96, 128, 70], [64, 94, 52], (y - 0.56) * 2.2), ground);
    for (const [cx, cy, r] of /** @type {const} */ ([[0.18, 0.42, 0.18], [0.46, 0.36, 0.22], [0.8, 0.44, 0.17]])) {
      const shade = smooth(0, r, Math.hypot(x - cx + r * 0.3, y - cy + r * 0.3));
      c = mix(c, mix([92, 132, 74], [44, 70, 40], shade), disc(x, y, cx, cy, r, 0.02));
      c = mix(c, [66, 52, 40], box(x, y, cx - 0.012, cy + r * 0.7, cx + 0.012, 0.6, 0.004));
    }
    const path = 1 - smooth(0.06, 0.08, Math.abs(x - 0.5 - (y - 0.58) * 0.9) - (y - 0.58) * 0.5);
    c = mix(c, [196, 186, 160], path * ground);
    return c;
  },
  (x, y) => {
    let c = mix([92, 88, 84], [52, 50, 48], smooth(0, 1, Math.hypot(x - 0.55, y - 0.4)));
    const pane = box(x, y, 0.3, 0.12, 0.84, 0.7, 0.01);
    c = mix(c, mix([236, 240, 238], [190, 204, 212], y), pane);
    c = mix(c, [70, 66, 62], pane * (box(x, y, 0.56, 0.12, 0.58, 0.7, 0.003) + box(x, y, 0.3, 0.4, 0.84, 0.42, 0.003)));
    c = mix(c, [150, 140, 128], box(x, y, 0.26, 0.7, 0.88, 0.74, 0.004));
    for (const [cx, cy, rx, ry] of /** @type {const} */ ([[0.4, 0.5, 0.06, 0.14], [0.47, 0.44, 0.05, 0.16],
      [0.34, 0.56, 0.07, 0.09], [0.5, 0.58, 0.06, 0.08]])) c = mix(c, [46, 70, 46], oval(x, y, cx, cy, rx, ry, 0.01));
    c = mix(c, [168, 104, 78], box(x, y, 0.36, 0.62, 0.52, 0.72, 0.006));
    return c;
  },
  (x, y) => {
    let c = mix([150, 178, 198], [222, 220, 210], smooth(0, 0.45, y));
    c = mix(c, [246, 230, 196], disc(x, y, 0.7, 0.3, 0.05, 0.03) * 0.8);
    const sea = smooth(0.46, 0.465, y);
    c = mix(c, mix([70, 108, 128], [104, 146, 158], (y - 0.46) * 4), sea);
    const sand = smooth(0.72 + Math.sin(x * 9) * 0.02, 0.74 + Math.sin(x * 9) * 0.02, y);
    c = mix(c, [236, 236, 228], sand * (1 - smooth(0.735, 0.75, y + Math.sin(x * 9) * 0.02)) * 0.8);
    c = mix(c, mix([210, 190, 156], [188, 166, 132], (y - 0.74) * 3), smooth(0.745, 0.755, y - Math.sin(x * 9) * 0.02));
    return c;
  },
  (x, y) => {
    const vein = Math.abs(Math.sin(x * 6 + y * 3 + Math.sin(y * 11) * 0.8));
    let c = mix([226, 224, 220], [200, 198, 194], smooth(0.97, 1, vein) * 0.5);
    c = mix(c, [150, 148, 144], disc(x, y, 0.56, 0.54, 0.3, 0.06) * 0.35);
    c = mix(c, [238, 236, 232], disc(x, y, 0.52, 0.5, 0.28, 0.008));
    c = mix(c, [238, 236, 232], box(x, y, 0.76, 0.46, 0.92, 0.54, 0.01));
    c = mix(c, [92, 58, 36], disc(x, y, 0.52, 0.5, 0.2, 0.008));
    c = mix(c, [196, 150, 106], disc(x, y, 0.52, 0.5, 0.13, 0.05) * 0.8);
    c = mix(c, [226, 196, 160], oval(x, y, 0.52, 0.5, 0.05, 0.08, 0.03) * 0.7);
    return c;
  },
];

/**
 * @param {number} seed
 * @param {number} [width]
 * @param {number} [height]
 */
export function scene(seed, width = 192, height = width) {
  const paint = PAINTERS[((seed % SCENES) + SCENES) % SCENES];
  const pixels = new Uint8ClampedArray(width * height * 4);
  const side = Math.min(width, height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const x = (column + 0.5 - (width - side) / 2) / side;
      const y = (row + 0.5 - (height - side) / 2) / side;
      const [r, g, b] = paint(x, y);
      const vignette = 1 - 0.28 * smooth(0.35, 0.8, Math.hypot(x - 0.5, y - 0.5));
      const grain = (hash(column, row, seed) - 0.5) * 7;
      const at = (row * width + column) * 4;
      pixels[at] = r * vignette + grain;
      pixels[at + 1] = g * vignette + grain;
      pixels[at + 2] = b * vignette + grain;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

/**
 * @param {number} seed
 * @param {number} [width]
 * @param {number} [height]
 */
export function sceneUrl(seed, width = 192, height = width) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.putImageData(new ImageData(scene(seed, width, height), width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

// @ts-check
import { attributes } from '../../lib/html.js';
import { button } from './button.js';
import { icon } from './icon.js';

const LEAST = 160;
const NOTCHES = 12;
const STEP = 10;
const STEP_FAR = 50;
const SCROLL_RATE = 1 / 450;
const PINCH_RATE = 1 / 100;

/** @typedef {{ x: number, y: number, side: number }} Square */
/** @typedef {{ src: string, width: number, height: number, square?: Square }} Picture */

/** @param {number} value @param {number} least @param {number} most */
const clamp = (value, least, most) => Math.min(most, Math.max(least, value));

/** @param {Picture} picture */
const sides = ({ width, height }) => {
  const most = Math.min(width, height);
  return { least: Math.min(LEAST, most), most };
};

/**
 * @param {Picture} picture
 * @param {Square} square
 */
function held(picture, { x, y, side }) {
  const { least, most } = sides(picture);
  const kept = clamp(side, least, most);
  const grown = (kept - side) / 2;
  return { x: clamp(x - grown, 0, picture.width - kept), y: clamp(y - grown, 0, picture.height - kept), side: kept };
}

/**
 * @param {Picture} picture
 * @returns {Square}
 */
const whole = picture => {
  const { most } = sides(picture);
  return { x: (picture.width - most) / 2, y: (picture.height - most) / 2, side: most };
};

/**
 * @param {Picture} picture
 * @param {Square} square
 * @param {number} side
 * @param {{ u: number, v: number }} at
 */
function scaled(picture, square, side, { u, v }) {
  const kept = clamp(side, sides(picture).least, sides(picture).most);
  return held(picture, { x: square.x + u * (square.side - kept), y: square.y + v * (square.side - kept), side: kept });
}

/**
 * @param {Picture} picture
 * @param {number} side
 */
function along(picture, side) {
  const { least, most } = sides(picture);
  return least === most ? 0 : Math.log(most / side) / Math.log(most / least);
}

/**
 * @param {Picture} picture
 * @param {number} t
 */
function sideAt(picture, t) {
  const { least, most } = sides(picture);
  return most * (least / most) ** clamp(t, 0, 1);
}

/**
 * @param {Picture} picture
 * @param {Square} square
 */
function answer(picture, square) {
  const side = Math.round(square.side);
  return {
    x: clamp(Math.round(square.x), 0, picture.width - side),
    y: clamp(Math.round(square.y), 0, picture.height - side),
    side,
  };
}

/**
 * @param {Picture} picture
 * @param {Square} square
 * @returns {[string, string][]}
 */
const placed = (picture, { x, y, side }) => {
  const share = (/** @type {number} */ n) => `${Math.round((n / side) * 1e6) / 1e4}%`;
  return [['left', share(-x)], ['top', share(-y)], ['width', share(picture.width)], ['height', share(picture.height)]];
};

/**
 * @param {Picture} picture
 * @param {number} side
 */
const scaleWords = (picture, side) => `${(Math.round((sides(picture).most / side) * 10) / 10).toLocaleString('en-US')}×`;

const scaleRow = (/** @type {Picture | null} */ picture, /** @type {Square | null} */ square) => {
  const open = Boolean(picture && square && sides(picture).least < sides(picture).most);
  return `<div class="ck-mas__scale"${open ? '' : ' aria-hidden="true"'}>${icon('photo', { size: 'sm' })}`
    + `<input${attributes({ class: 'ck-mas__slider', type: 'range', min: '0', max: '1', step: 'any',
      value: picture && square ? String(along(picture, square.side)) : '0', 'aria-label': 'Scale',
      'aria-valuetext': picture && square ? scaleWords(picture, square.side) : null, disabled: !open,
      tabindex: open ? null : '-1' })}>`
    + `${icon('photo', { size: 'lg' })}</div>`;
};

/** @param {boolean} usable */
const acts = usable => '<div class="ck-mas__acts">'
  + button('Cancel', { key: 'Esc', attrs: { 'data-ck-mas': 'cancel' } })
  + button('Use', { variant: 'primary', key: '⏎', disabled: !usable, attrs: { 'data-ck-mas': 'use' } }) + '</div>';

/** @param {Picture | null} picture */
export function moveAndScale(picture) {
  if (!picture) {
    return '<div class="ck-mas is-refused"><div class="ck-mas__stage" role="status">'
      + `${icon('photo', { size: 'xl' })}<p class="ck-mas__said mac-body">This picture can't be opened here. <span class="ck-mas__try">Try a JPEG or a PNG.</span></p></div>`
      + `${scaleRow(null, null)}${acts(false)}</div>`;
  }
  const square = held(picture, picture.square ?? whole(picture));
  return `<div${attributes({ class: 'ck-mas', 'data-width': picture.width, 'data-height': picture.height,
    'data-x': square.x, 'data-y': square.y, 'data-side': square.side })}>`
    + `<div${attributes({ class: 'ck-mas__stage', tabindex: '0', role: 'application', 'aria-roledescription': 'photo',
      'aria-label': 'The picture: drag or use the arrow keys to move it, scroll or use + and − to scale it' })}>`
    + `<img${attributes({ class: 'ck-mas__img', src: picture.src, alt: '', draggable: 'false', decoding: 'async',
      'data-geo': placed(picture, square).map(([name, value]) => `${name}:${value}`).join(';') })}>`
    + '<span class="ck-mas__circle" aria-hidden="true"></span></div>'
    + `${scaleRow(picture, square)}${acts(true)}</div>`;
}

/**
 * @param {Element} root
 * @param {{ used: (square: Square) => void, cancelled: () => void }} acts
 */
export function installMoveAndScale(root, { used, cancelled }) {
  const part = /** @type {HTMLElement} */ (root.matches('.ck-mas') ? root : root.querySelector('.ck-mas'));
  const stage = /** @type {HTMLElement} */ (part.querySelector('.ck-mas__stage'));
  const picture = /** @type {HTMLImageElement | null} */ (part.querySelector('.ck-mas__img'));
  const slider = /** @type {HTMLInputElement} */ (part.querySelector('.ck-mas__slider'));
  const size = part.classList.contains('is-refused') ? null
    : { src: '', width: Number(part.dataset.width), height: Number(part.dataset.height) };
  /** @type {Square} */
  let square = { x: Number(part.dataset.x), y: Number(part.dataset.y), side: Number(part.dataset.side) };

  /** @param {Square} next */
  const show = next => {
    if (!size || !picture) return;
    square = next;
    for (const [name, value] of placed(size, square)) picture.style.setProperty(name, value);
    slider.value = String(along(size, square.side));
    slider.setAttribute('aria-valuetext', scaleWords(size, square.side));
  };
  /** @param {{ clientX: number, clientY: number }} at */
  const onStage = ({ clientX, clientY }) => {
    const box = stage.getBoundingClientRect();
    return { u: clamp((clientX - box.left) / box.width, 0, 1), v: clamp((clientY - box.top) / box.height, 0, 1), side: box.width };
  };
  show(square);
  const middle = { u: 0.5, v: 0.5 };
  /** @param {number} notches */
  const step = notches => {
    if (size) show(scaled(size, square, sideAt(size, along(size, square.side) + notches / NOTCHES), middle));
  };
  /**
   * @param {number} right
   * @param {number} down
   */
  const move = (right, down) => {
    if (!size) return;
    const per = square.side / stage.getBoundingClientRect().width;
    show(held(size, { x: square.x - right * per, y: square.y - down * per, side: square.side }));
  };
  const use = () => {
    if (size) used(answer(size, square));
  };

  /** @type {{ id: number, x: number, y: number } | null} */
  let press = null;
  stage.addEventListener('pointerdown', event => {
    if (!size || event.button !== 0 || press) return;
    event.preventDefault();
    stage.focus({ preventScroll: true });
    stage.setPointerCapture(event.pointerId);
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    stage.classList.add('is-moving');
  });
  stage.addEventListener('pointermove', event => {
    if (!size || !press || event.pointerId !== press.id) return;
    move(event.clientX - press.x, event.clientY - press.y);
    press = { ...press, x: event.clientX, y: event.clientY };
  });
  for (const kind of /** @type {const} */ (['pointerup', 'pointercancel', 'lostpointercapture'])) {
    stage.addEventListener(kind, event => {
      if (press && event.pointerId === press.id) {
        press = null;
        stage.classList.remove('is-moving');
      }
    });
  }

  /** @type {{ square: Square, at: { u: number, v: number } } | null} */
  let pinch = null;
  stage.addEventListener('wheel', event => {
    if (!size) return;
    event.preventDefault();
    if (pinch && event.ctrlKey) return;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    show(scaled(size, square, square.side * Math.exp(pixels * (event.ctrlKey ? PINCH_RATE : SCROLL_RATE)), onStage(event)));
  }, { passive: false });
  stage.addEventListener('gesturestart', (/** @type {any} */ event) => {
    event.preventDefault();
    pinch = { square, at: onStage(event) };
  });
  stage.addEventListener('gesturechange', (/** @type {any} */ event) => {
    event.preventDefault();
    if (size && pinch && event.scale > 0) show(scaled(size, pinch.square, pinch.square.side / event.scale, pinch.at));
  });
  stage.addEventListener('gestureend', (/** @type {any} */ event) => {
    event.preventDefault();
    pinch = null;
  });

  slider.addEventListener('input', () => {
    if (size) show(scaled(size, square, sideAt(size, Number(slider.value)), middle));
  });

  part.addEventListener('click', event => {
    const act = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-ck-mas]'));
    if (act?.dataset.ckMas === 'use') use();
    if (act?.dataset.ckMas === 'cancel') cancelled();
  });

  /** @type {Record<string, [number, number]>} */
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  /** @type {Record<string, number>} */
  const SLIDER = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -3, PageUp: 3, Home: -NOTCHES, End: NOTCHES };
  part.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = /** @type {Element} */ (event.target);
    const onButton = target.closest('button') !== null;
    let taken = true;
    if (event.key === 'Escape') cancelled();
    else if (event.key === 'Enter' && !onButton) use();
    else if (event.key === '+' || event.key === '=') step(1);
    else if (event.key === '-' || event.key === '_') step(-1);
    else if (target === slider && event.key in SLIDER) step(SLIDER[event.key]);
    else if (event.key in ARROWS) {
      const [right, down] = ARROWS[event.key];
      const by = event.shiftKey ? STEP_FAR : STEP;
      move(right * by, down * by);
    } else taken = false;
    if (!taken) return;
    event.preventDefault();
    event.stopPropagation();
  });

  return {
    focus: () => (size ? stage : /** @type {HTMLElement} */ (part.querySelector('[data-ck-mas="cancel"]')))
      .focus({ preventScroll: true }),
  };
}

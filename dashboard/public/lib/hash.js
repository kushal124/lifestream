// @ts-check

export const LIFE_VIEWS = ['ask', 'days', 'people', 'places', 'connectors', 'agents', 'search', 'onboarding'];

/**
 * @typedef {object} Route
 * @property {string} view
 * @property {string} on
 * @property {string} focus
 * @property {string} seg
 * @property {string} q
 * @property {string} chat
 * @property {string} dialog
 * @property {string} flow
 * @property {string} tour
 */

export const FLOWS = /** @type {const} */ (['vault', 'phone', 'browser']);

/** @param {string | null} value */
const flowOf = value => /** @type {readonly string[]} */ (FLOWS).includes(value ?? '') ? /** @type {string} */ (value) : '';

const ROUTE_KEYS = /** @type {const} */ (['on', 'focus', 'seg', 'q', 'chat', 'dialog', 'flow', 'tour']);

/**
 * @param {string} hash
 * @returns {Route}
 */
export function parseRoute(hash) {
  const params = new URLSearchParams(hash.replace(/^#/u, ''));
  const view = params.get('view') ?? '';
  return {
    view: LIFE_VIEWS.includes(view) ? view : 'ask',
    on: params.get('on') || '',
    focus: params.get('focus') || '',
    seg: params.get('seg') || '',
    q: params.get('q') || '',
    chat: params.get('chat') || '',
    dialog: params.get('dialog') || '',
    flow: flowOf(params.get('flow')),
    tour: params.has('tour') ? params.get('tour') || '1' : '',
  };
}

/** @param {string} hash */
export const namesView = hash => new URLSearchParams(hash.replace(/^#/u, '')).has('view');

/** @param {Route} route */
export function routeHash(route) {
  const params = new URLSearchParams({ view: route.view });
  for (const key of ROUTE_KEYS) if (route[key]) params.set(key, route[key]);
  return '#' + params;
}

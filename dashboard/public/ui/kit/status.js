// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { checkDisc, spinner } from './button.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';

/** @typedef {'done' | 'working' | 'wanted' | 'failed'} StatusState */

const HEARD = { done: 'done', working: 'under way', wanted: 'not yet', failed: 'failed' };

/**
 * @param {StatusState} state
 * @param {string} [words]
 */
export const status = (state, words = '') => `<span${attributes({ class: `ck-status is-${state}`,
  role: state === 'failed' ? 'alert' : null })}>`
  + `<span class="ck-status__mark" aria-hidden="true">${state === 'done' ? checkDisc({ size: 14 })
    : state === 'working' ? spinner() : state === 'failed' ? signalShape('warning') : '<span class="ck-status__ring"></span>'}</span>`
  + (words ? `<span class="ck-status__words mac-subhead">${esc(words)}</span>`
    : `<span class="sr-only">${HEARD[state]}</span>`) + '</span>';

/**
 * @param {string} words
 * @param {{ icon?: string, end?: string }} [options]
 */
export const plain = (words, { icon: meaning = '', end = '' } = {}) => `<p class="ck-plain mac-subhead">`
  + `${meaning ? icon(meaning, { size: 'xs' }) : ''}<span class="ck-plain__words">${esc(words)}</span>${end}</p>`;

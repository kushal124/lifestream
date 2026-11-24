// @ts-check
import { attributes, esc } from '../../lib/html.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */
/** @typedef {{ text: string, bold?: boolean }[]} Bolded */

/** @param {Bolded} bolded */
export const boldRuns = bolded => bolded.map(run => run.bold ? `<b>${esc(run.text)}</b>` : esc(run.text)).join('');

/**
 * @param {Bolded} bolded
 * @param {{ attrs?: Attributes }} [options]
 */
export const boldLine = (bolded, { attrs = {} } = {}) => {
  const { class: own = '', ...rest } = attrs;
  return `<p${attributes({ class: ['ck-boldline', String(own)].filter(Boolean).join(' '), ...rest })}>${boldRuns(bolded)}</p>`;
};

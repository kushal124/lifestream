// @ts-check
import { attributes, esc } from '../../lib/html.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} rows
 * @param {string} rows.label
 * @param {{ value: string, title: string, end?: string }[]} rows.choices
 * @param {string} [rows.picked]
 * @param {(value: string) => Attributes} [rows.attrs]
 */
export function choiceRows({ label, choices, picked = '', attrs = () => ({}) }) {
  const stop = choices.some(choice => choice.value === picked) ? picked : choices[0]?.value;
  return `<div${attributes({ class: 'ck-choices', role: 'radiogroup', 'aria-label': label })}>`
    + choices.map(({ value, title, end = '' }) => {
      const on = value === picked;
      return `<div${attributes({ class: `ck-choice${on ? ' is-on' : ''}`, role: 'radio', 'aria-checked': String(on),
        tabindex: value === stop ? '0' : '-1', 'data-ck-choice': value, ...attrs(value) })}>`
        + '<span class="ck-choice__mark" aria-hidden="true"></span>'
        + `<span class="ck-choice__title mac-body">${esc(title)}</span>`
        + (end ? `<span class="ck-choice__end mac-body">${end}</span>` : '') + '</div>';
    }).join('') + '</div>';
}

/** @param {HTMLElement} root */
export function installChoiceRows(root) {
  root.addEventListener('keydown', event => {
    const row = /** @type {Element} */ (event.target);
    const group = row.parentElement;
    if (!row.classList?.contains('ck-choice') || !group?.classList.contains('ck-choices')
      || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      /** @type {HTMLElement} */ (row).click();
      return;
    }
    /** @type {Record<string, number>} */
    const steps = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const rows = [...group.querySelectorAll(':scope > .ck-choice')];
    const next = /** @type {HTMLElement} */ (rows[(rows.indexOf(row) + steps[event.key] + rows.length) % rows.length]);
    next.focus();
    next.click();
  });
}

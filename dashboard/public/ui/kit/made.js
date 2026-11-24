// @ts-check
/** @import { Made } from '../../types.js' */
/** @import { Host } from '../../lib/host.js' */
import { attributes, esc } from '../../lib/html.js';
import { onHomeChange } from '../live.js';
import { button } from './button.js';
import { menuButton } from './menu-button.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @typedef {{ now: string, again: string }} MadeVerbs */
/** @type {MadeVerbs} */
export const DESCRIBE = { now: 'Describe now', again: 'Describe again' };
/** @type {MadeVerbs} */
export const TRANSCRIBE = { now: 'Transcribe now', again: 'Transcribe again' };

/** @param {import('../../types.js').Step} step */
const stepLine = step => [step.words, step.note ?? ''].filter(Boolean).join(' · ');

/**
 * @param {object} part
 * @param {Made | null | undefined} part.made
 * @param {MadeVerbs} part.verbs
 * @param {boolean} part.acts
 * @param {boolean} [part.busy]
 * @param {string} part.id
 * @param {Attributes} [part.attrs]
 */
export function made({ made: what, verbs, acts, busy = false, id, attrs = {} }) {
  if (!what) return '';
  const answered = what.state === 'done';
  const line = what.line ?? '';
  const act = !acts || !what.ask || !what.choose.length ? ''
    : answered ? menuButton({ id: `made-${id}`, label: verbs.again, words: verbs.again, busy, attrs,
      choices: what.choose.map(step => ({ value: step.value, words: step.words, note: step.note ?? '', chosen: false, default: false })) })
    : '<div class="ck-made__now">' + button(verbs.now, { size: 'sm', busy, attrs: { ...attrs, 'data-value': what.choose[0].value } })
      + `<p class="ck-made__to mac-subhead">${esc(stepLine(what.choose[0]))}</p></div>`;
  if (!line && !act) return '';
  return `<div${attributes({ class: `ck-made${answered ? ' is-done' : ''}`, 'data-made': what.state })}>`
    + (line ? `<p class="ck-made__line mac-subhead">${esc(line)}</p>` : '') + act + '</div>';
}

/** @param {{ words: string, href: string | null } | null | undefined} sent */
export const sentLine = sent => sent ? `<p class="ck-made__sent mac-subhead">${esc(sent.words)}`
  + (sent.href ? ` · <a${attributes({ href: sent.href, 'data-ck-sent': '' })}>See what was sent</a>` : '') + '</p>' : '';

/** @typedef {NonNullable<Made['ask']>} Ask */

/** @param {Ask} ask */
const keyOf = ask => `${ask.family}\0${ask.item}\0${ask.prompt}`;

/** @param {Host | null} host */
export function madeActs(host) {
  const sending = /** @type {Set<string>} */ (new Set());
  const refused = /** @type {Map<string, string>} */ (new Map());
  /** @param {Made | null | undefined} made */
  const awaits = made => Boolean(made?.ask && made.state === 'waiting' && made.choose.length === 0);
  return {
    hosted: host !== null,
    /** @param {Made | null | undefined} made */
    busy: made => Boolean(made?.ask && sending.has(keyOf(made.ask))),
    /** @param {Made | null | undefined} made */
    refused: made => made?.ask ? refused.get(keyOf(made.ask)) ?? '' : '',
    /**
     * @param {object} part
     * @param {() => (Made | null | undefined)[]} part.made
     * @param {() => Promise<void>} part.read
     * @param {() => void} part.draw
     * @param {() => boolean} part.live
     * @returns {{ choose: (ask: Ask, route: string) => Promise<void>, stop: () => void }}
     */
    follow({ made, read, draw, live }) {
      let reading = false;
      let owed = false;
      async function again() {
        if (reading) {
          owed = true;
          return;
        }
        reading = true;
        try {
          await read();
        } catch {}
        reading = false;
        if (!live()) return;
        draw();
        if (!owed) return;
        owed = false;
        await again();
      }
      const stop = onHomeChange(() => {
        if (!live()) stop();
        else if (reading) owed = true;
        else if (made().some(awaits)) void again();
      });
      return {
        stop,
        async choose(ask, route) {
          const key = keyOf(ask);
          if (!host || sending.has(key)) return;
          sending.add(key);
          refused.delete(key);
          draw();
          try {
            await host.act({ act: 'process', family: ask.family, item: ask.item, prompt: ask.prompt, route });
          } catch (error) {
            refused.set(key, error instanceof Error ? error.message : String(error));
          }
          await again();
          sending.delete(key);
          if (live()) draw();
        },
      };
    },
  };
}

/** @typedef {ReturnType<typeof madeActs>} MadeActs */

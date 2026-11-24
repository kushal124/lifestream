// @ts-check
/** @import { Choice, ModelFile, ModelKind, ModelRunner, ModelsRead } from '../../types.js' */
/** @import { Flow, ModelItem } from '../flows/model.js' */
/** @import { HostAct, HostState } from '../../lib/host.js' */
/** @import { DetailPart, Opened, PanelRow } from './dialog.js' */
/** @import { Act, Do } from './words.js' */
import { planName, planWanted } from '../flows/model.js';
import { rowOf } from './dialog.js';
import { thingKey } from './pending.js';
import { part } from './settings-pages.js';

/** @type {[ModelKind, string][]} */
const KINDS = [['pictures', 'Pictures'], ['audio', 'Audio'], ['text', 'Text']];

const TAKES = /** @type {const} */ ([['pictures,text', 'Pictures and text'], ['text', 'Text'], ['pictures', 'Pictures']]);

export const MODEL_FIELDS = { key: 'openrouter', url: 'address.url', model: 'address.model', takes: 'address.kinds' };

export const SUBSCRIPTIONS = /** @type {ModelItem[]} */ (['chatgpt', 'claude']);

/** @param {HostAct} act @returns {Do} */
const asking = act => ({ host: act });

/**
 * @param {Opened} opened
 * @param {string} key
 */
const typed = (opened, key) => opened.fields?.[key] ?? '';

/**
 * @param {Opened} opened
 * @returns {HostAct | null}
 */
export function keyAct(opened) {
  const key = typed(opened, MODEL_FIELDS.key).trim();
  return key ? { act: 'seal', secret: 'openrouter', value: key } : null;
}

/**
 * @param {Opened} opened
 * @returns {HostAct | null}
 */
export function addressAct(opened) {
  const url = typed(opened, MODEL_FIELDS.url).trim();
  const model = typed(opened, MODEL_FIELDS.model).trim();
  const kinds = /** @type {ModelKind[]} */ ((typed(opened, MODEL_FIELDS.takes) || TAKES[0][0]).split(','));
  return url && model ? { act: 'models', do: 'address', url, model, kinds } : null;
}

/**
 * @param {Flow | null} flow
 * @returns {DetailPart | null}
 */
const subscriptionsOf = flow => flow && { label: 'Subscriptions', lines: [], panel: null, acts: [], flow };

/**
 * @param {ModelsRead} models
 * @param {boolean} acts
 * @param {Opened} opened
 * @returns {DetailPart}
 */
function keysOf(models, acts, opened) {
  const remove = (/** @type {HostAct} */ act) => [/** @type {Act} */ ({ label: 'Remove', variant: 'plain', do: asking(act) })];
  const key = typed(opened, MODEL_FIELDS.key);
  const openrouter = models.openrouter.connected
    ? rowOf('OpenRouter', { line: 'Pay per call with your own key.', end: { words: 'Connected', done: true,
      acts: acts ? remove({ act: 'seal', secret: 'openrouter', value: null }) : [] } })
    : rowOf('OpenRouter', { line: 'Pay per call with your own key.',
      end: acts ? { field: { key: MODEL_FIELDS.key, label: 'OpenRouter key', kind: 'secret', value: key, placeholder: 'sk-or-…' },
        acts: [{ label: 'Save', variant: 'secondary', disabled: !key.trim(), do: { save: 'openrouter' } }] } : { words: 'Not set' } });
  const { address } = models;
  const line = 'Any server that speaks the OpenAI API, such as Ollama or LM Studio.';
  const custom = address
    ? rowOf('Custom server', { line: address.words, only: address.takes,
      end: acts ? { acts: remove({ act: 'models', do: 'address', none: true }) } : { words: 'Set' } })
    : rowOf('Custom server', { line, end: { words: 'Not set',
      acts: acts ? [{ label: 'Add server', variant: 'secondary', do: { page: 'address' } }] : [] } });
  return part({ label: 'API keys', rows: [openrouter, custom] });
}

/**
 * @param {ModelRunner} runner
 * @param {ModelFile} file
 * @param {boolean} acts
 * @returns {PanelRow}
 */
export function fileRow(runner, file, acts) {
  /** @param {string} label @param {'fetch' | 'remove'} to @param {Partial<Act>} [look] @returns {Act} */
  const act = (label, to, look = {}) => ({ label, variant: 'secondary', ...look,
    do: asking({ act: 'models', do: 'file', runner: runner.unit, id: file.id, to }) });
  const end = !acts ? null : file.state === 'absent' ? act('Download', 'fetch')
    : file.state === 'fetching' ? act('Cancel', 'remove', { variant: 'plain' })
      : file.state === 'ready' ? act('Remove', 'remove', { variant: 'plain' }) : act('Try again', 'fetch');
  const ready = file.state === 'ready';
  return rowOf(file.name, { line: file.about, only: file.line ?? '', end: end ? { words: ready ? 'Downloaded' : '', done: ready, acts: [end] }
    : ready ? { words: 'Downloaded', done: true } : null });
}

export const SAVE_BATTERY = "Runs only today's and yesterday's items on battery; the rest wait until it's plugged in.";

/**
 * @param {ModelsRead} models
 * @param {HostState | null} state
 * @param {boolean} acts
 * @returns {DetailPart[]}
 */
const runnersOf = (models, state, acts) => models.runners.map(runner => {
  const runs = runner.line === null;
  const held = runs && (runner.paused !== null || runner.files.some(file => file.state === 'ready'));
  const on = runner.paused === null;
  const run = held ? [rowOf('Run models', { line: on ? 'Turn off to hold their work until you turn it back on.' : runner.paused ?? '',
    end: acts ? { toggle: { on, label: 'Run models', do: asking({ act: 'models', do: 'runner', runner: runner.unit, to: on ? 'pause' : 'resume' }) } }
      : { words: on ? 'On' : 'Off' } })] : [];
  const battery = runs && runner.battery ? [rowOf('Save battery', { line: SAVE_BATTERY,
    end: acts ? { toggle: { on: runner.battery.on, label: 'Save battery',
      do: asking({ act: 'models', do: 'battery', runner: runner.unit, to: runner.battery.on ? 'spend' : 'save' }) } }
      : { words: runner.battery.on ? 'On' : 'Off' } })] : [];
  const label = state?.unit && runner.unit === `runner-${state.unit}` ? 'On this Mac' : `On ${runner.name}`;
  if (!runner.files.length && !run.length) return part({ label, rows: [rowOf(runner.line ?? 'No models on this machine yet.')] });
  return part({ label, line: runner.line ?? runner.battery?.held ?? '', rows: [...run, ...battery, ...runner.files.map(file => fileRow(runner, file, acts && runs))] });
});

/**
 * @param {ModelsRead} models
 * @param {boolean} acts
 * @param {HostState | null} state
 * @returns {DetailPart}
 */
function defaultsOf(models, acts, state) {
  const rows = KINDS.map(([kind, label]) => {
    /** @type {Choice} */
    const choice = models.defaults[kind];
    const { words } = choice;
    if (!acts) return rowOf(label, { end: { words } });
    return rowOf(label, { end: { menu: { id: `settings.default.${kind}`, busy: thingKey({ kind: 'default', of: kind }), label, words,
      find: '', date: null,
      choices: choice.steps.map(step => {
        const wanted = planWanted(step.value, state?.ask_login);
        return { words: step.words, note: step.note ?? (wanted ? `Connect ${planName(wanted)} above` : ''), chosen: step.value === choice.value,
          default: false, do: asking({ act: 'models', do: 'default', kind, route: step.value }) };
      }) } } });
  });
  return part({ label: 'Defaults', line: 'What a connector uses unless you pick another under its AI.', rows });
}

/**
 * @param {{ models: ModelsRead | null, failed: boolean, subscriptions: Flow | null, state: HostState | null, acts: boolean, opened: Opened }} read
 * @returns {{ parts: DetailPart[], reading: boolean }}
 */
export function modelsParts({ models, failed, subscriptions, state, acts, opened }) {
  const plans = subscriptionsOf(subscriptions);
  const mounted = plans ? [plans] : [];
  if (!models) return { parts: mounted, reading: !failed };
  const acting = acts && !failed;
  return { parts: [...mounted, keysOf(models, acting, opened), ...runnersOf(models, state, acting), defaultsOf(models, acting, state)],
    reading: false };
}

/**
 * @param {Opened} opened
 * @returns {DetailPart}
 */
export function addressPage(opened) {
  const takes = typed(opened, MODEL_FIELDS.takes) || TAKES[0][0];
  /** @param {string} key @param {string} label @param {string} placeholder */
  const field = (key, label, placeholder) => rowOf(label, { end: { field: { key, label, kind: 'text', value: typed(opened, key),
    placeholder } } });
  return part({ label: 'Custom server', line: 'Any server that speaks the OpenAI API, such as Ollama or LM Studio.',
    acts: [{ label: 'Save', variant: 'primary', disabled: addressAct(opened) === null, do: { save: 'address' } }],
    rows: [field(MODEL_FIELDS.url, 'Address', 'http://127.0.0.1:11434/v1'), field(MODEL_FIELDS.model, 'Model', 'qwen3.5:4b'),
      rowOf('Takes', { end: { menu: { id: 'settings.address.takes', busy: '', label: 'Takes', words: TAKES.find(([value]) => value === takes)?.[1] ?? '',
        find: '', date: null, choices: TAKES.map(([value, words]) => ({ words, note: '', chosen: value === takes, default: false,
          do: { typed: { key: MODEL_FIELDS.takes, value } } })) } } })] });
}

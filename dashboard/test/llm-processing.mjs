import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESCRIBED, LLM_REPORT, MODELS, MODELS_BARE, RANGE_STEP, SHAPED, SUBSCRIBED, TRANSCRIBED } from '../public/kit-gallery-llm.js';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { AI_PAGE, detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { LACKS } from '../public/ui/connectors/changes.js';
import { isSettings, NOTES, savedAct, SETTINGS_MODELS, SETTINGS_PRIVACY, settingsDetail, shownPage, TYPED } from '../public/ui/connectors/settings.js';
import { SAVE_BATTERY, SUBSCRIPTIONS } from '../public/ui/connectors/settings-models.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { actKey, keyOf, landedOf, pendingOf, settled, thingKey } from '../public/ui/connectors/pending.js';
import { ELSEWHERE, flowOf, MODEL_ITEMS, modelOf, sessionOf } from '../public/ui/flows/model.js';
import { flowPageRows } from '../public/ui/flows/view.js';
import { esc } from '../public/lib/html.js';
import { DESCRIBE, made, TRANSCRIBE } from '../public/ui/kit/made.js';

/** @typedef {import('../public/ui/connectors/dialog.js').Detail} Detail */
/** @typedef {import('../public/ui/connectors/dialog.js').Panel} Panel */
/** @typedef {import('../public/types.js').ConnectorReport} ConnectorReport */

/** @param {string} id */
const connectorOf = id => /** @type {ConnectorReport} */ (LLM_REPORT.connectors.find(each => each.id === id));
/**
 * @param {string} id
 * @param {any} state
 */
const dialog = (id, state) => /** @type {Detail} */ (detailOf(LLM_REPORT, state, id, OPENED));
/** @param {Detail} detail @param {string} label */
const panel = (detail, label) => detail.panels.find(each => each.label === label);
/**
 * @param {string} id
 * @param {string} key
 * @param {any} state
 */
const pageOf = (id, key, state) => /** @type {Detail} */ (detailOf(LLM_REPORT, state, id, { ...OPENED, pages: [`${AI_PAGE}${key}`] }));
/** @param {any} end */
const menuOf = end => end?.menu ?? null;
/**
 * @param {string} id
 * @param {any} state
 */
const aiOf = (id, state) => /** @type {Panel} */ (panel(dialog(id, state), 'AI'));
/** @param {string} id */
const worksOf = id => (connectorOf(id).processing?.rows ?? []).filter(row => row.shape !== null);
/** @param {string} markup */
const actsIn = markup => [...markup.matchAll(/(?:data-cn-do|data-value)="([^"]*)"/gu)]
  .map(match => { try { return JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&#39;', '\'').replaceAll('&amp;', '&')); } catch { return null; } })
  .filter(each => each && typeof each === 'object');
/** @param {any} act */
const aiAct = act => act.host?.member?.startsWith('llm.') || (act.open && !String(act.open).startsWith('import:'));
/** @param {any} state */
const plansOf = state => flowOf('model', { state, report: null }, { ...sessionOf(state !== null, 'dialog'), models: [...SUBSCRIPTIONS] },
  Date.UTC(2026, 9, 28, 12));
/** @type {import('../public/lib/reach.js').Drawn} */
const READ_FAILED = { kind: 'lack', words: null, retry: true };
/** @param {Partial<Parameters<typeof settingsDetail>[0]>} read */
const settings = read => settingsDetail({ report: REPORT, models: MODELS, failed: null, state: HOST_STATE, id: SETTINGS_MODELS, opened: OPENED,
  subscriptions: plansOf(read.state === undefined ? HOST_STATE : read.state), ...read });
/** @param {Detail} detail */
const partLabels = detail => detail.parts.map(each => each.label);
/** @param {Detail} detail @param {string} label */
const part = (detail, label) => detail.parts.find(each => each.label === label);
/** @param {Detail} detail @param {string} partLabel @param {string} rowLabel */
const rowIn = (detail, partLabel, rowLabel) => part(detail, partLabel)?.panel?.rows.find(each => each.label === rowLabel);
/** @param {any} row */
const endActs = row => (row?.end?.acts ?? []).map((/** @type {any} */ act) => [act.label, act.do]);
const BARRED = /\b(?:work|route|kind|floor|family|grant)s?\b/iu;
const RUN_LINE = 'Turn off to hold their work until you turn it back on.';

test('L1: AI its own section after Settings and before History, a row per work, each work\'s sentence on its own page; none for a connector without one', () => {
  for (const id of SHAPED) {
    const labels = dialog(id, HOST_STATE).panels.map(each => each.label);
    const at = labels.indexOf('AI');
    assert.ok(at >= 0, `${id}: drawn`);
    const settings = labels.indexOf('Settings');
    if (settings >= 0) assert.equal(settings, at - 1, `${id}: right after Settings`);
    const history = labels.indexOf('History');
    if (history >= 0) assert.equal(history, at + 1, `${id}: History right after`);
    assert.equal(labels.some(label => ['LLM processing', 'Data backfill', 'Backfill', 'Groups'].includes(label)), false, `${id}: ${labels}`);
    assert.equal(aiOf(id, HOST_STATE).about, '', `${id}: no sentence of the section's own`);
  }
  for (const report of [LLM_REPORT, REPORT]) {
    const detail = /** @type {Detail} */ (detailOf(report, HOST_STATE, 'github', OPENED));
    assert.equal(panel(detail, 'AI'), undefined);
  }
  for (const id of ['whatsapp', 'chatgpt', 'apple-photos']) {
    const labels = dialog(id, HOST_STATE).panels.map(each => each.label);
    assert.equal(labels.indexOf('History'), labels.indexOf('AI') + 1, `${id}: History drawn after`);
    assert.equal(panel(dialog(id, HOST_STATE), 'History')?.about, connectorOf(id).backfill_about ?? '');
  }
  const whatsapp = detailMarkup(dialog('whatsapp', HOST_STATE), AT_REST);
  assert.ok(whatsapp.includes('ck-ssection__heading">AI<'));
  for (const row of worksOf('whatsapp')) {
    const about = memberOf('whatsapp', row.member).about ?? '';
    assert.ok(about && detailMarkup(pageOf('whatsapp', row.member, HOST_STATE), AT_REST).includes(esc(about)),
      `${row.member}: its page says the home's sentence`);
  }
});

/**
 * @param {string} id
 * @param {string} key
 */
const memberOf = (id, key) => /** @type {import('../public/types.js').MemberState} */ (connectorOf(id).members.find(each => each.key === key));

test('L2, L3: a row per work pushing its page, Range last; on the page its model drawn as every member is, the line and mark the work\'s, the needs line opening AI models', () => {
  const MARKS = { off: null, needs: { look: 'needs-you' }, waiting: { status: 'waiting' }, running: { status: 'running' },
    done: { status: 'done' } };
  const seen = new Set();
  for (const id of SHAPED) {
    const processing = /** @type {import('../public/types.js').Processing} */ (connectorOf(id).processing);
    const section = aiOf(id, HOST_STATE);
    assert.deepEqual(section.rows.map(row => row.label), processing.rows.map(row => memberOf(id, row.member).label),
      `${id}: a row per member the part names, in its order`);
    assert.equal(processing.rows.at(-1)?.shape, null, `${id}: the range's row last`);
    assert.equal(section.rows.at(-1)?.label, memberOf(id, 'llm.range').label, `${id}: the range's row last`);
    processing.rows.forEach((row, at) => {
      if (row.shape === null) return;
      seen.add(row.shape);
      const member = memberOf(id, row.member);
      const listed = section.rows[at];
      assert.deepEqual([listed.lead, listed.line, listed.go, listed.end], [{ icon: 'ai' }, row.line ?? member.words,
        { do: { page: `${AI_PAGE}${row.member}` }, value: '' }, null], `${id} ${row.member}: a row that pushes`);
      const inside = pageOf(id, row.member, HOST_STATE);
      assert.deepEqual([inside.name, inside.back], [member.label, { label: `Back to ${connectorOf(id).name}` }]);
      const each = inside.panels[0].rows[0];
      assert.equal(each.label, 'Model');
      assert.deepEqual([each.does ?? '', each.line], row.line ? [member.about ?? '', row.line] : ['', member.about ?? '']);
      assert.deepEqual(each.mark, MARKS[row.shape], `${id} ${row.member}: its shape's mark`);
      assert.deepEqual(each.act, row.shape === 'needs' ? { open: SETTINGS_MODELS } : row.privacy?.waiting ? { open: SETTINGS_PRIVACY } : null);
      assert.deepEqual(each.waiting, (member.waiting ?? []).map(wait => wait.line));
      const menu = menuOf(each.end);
      assert.equal(menu.words, member.words);
      assert.deepEqual(menu.choices.map((/** @type {any} */ choice) => [choice.words, choice.note, choice.chosen, choice.default]),
        (member.steps ?? []).map(step => [step.words, step.note ?? '', step.value === member.value, false]),
        `${id} ${row.member}: no step marked Default, its Default step naming itself`);
      assert.equal(inside.panels[0].rows.length, row.privacy ? 2 : 1, `${id} ${row.member}: its hiding under its model`);
      assert.equal(dialog(id, HOST_STATE).panels.flatMap(panel => panel.rows).filter(drawn => drawn.label === member.label).length, 1,
        member.label);
    });
  }
  assert.deepEqual([...seen].sort(), ['done', 'needs', 'off', 'running', 'waiting'], 'every shape drawn');
  const gone = { ...LLM_REPORT, connectors: LLM_REPORT.connectors.map(each => each.id !== 'gmail' ? each
    : { ...each, members: each.members.filter(member => member.key !== 'llm.mail') }) };
  assert.deepEqual(/** @type {Panel} */ (panel(/** @type {Detail} */ (detailOf(gone, HOST_STATE, 'gmail', OPENED)), 'AI')).rows
    .map(row => row.label), [memberOf('gmail', 'llm.range').label]);
  assert.equal(SETTINGS_MODELS, 'settings/models');
  assert.ok(isSettings(SETTINGS_MODELS));
});

test('L4: a step on a work\'s page sends its setting, the range its own with its date row; in a browser words alone', () => {
  for (const id of SHAPED) {
    for (const row of worksOf(id)) {
      const model = pageOf(id, row.member, HOST_STATE).panels[0].rows[0];
      assert.deepEqual(menuOf(model.end).choices.map((/** @type {any} */ choice) => choice.do),
        (memberOf(id, row.member).steps ?? []).map(step => ({ host: { act: 'setting', connector: id, member: row.member, value: step.value } })));
      assert.equal(menuOf(model.end).date, null, row.member);
      const browser = pageOf(id, row.member, null).panels[0].rows[0];
      assert.deepEqual([browser.end, browser.act], [{ words: memberOf(id, row.member).words }, null], `${id} ${row.member}: words in a browser`);
      const markup = detailMarkup(pageOf(id, row.member, null), AT_REST);
      assert.equal(actsIn(markup).some(aiAct), false, `${id} ${row.member}: no act in a browser`);
    }
    const range = /** @type {import('../public/types.js').Processing} */ (connectorOf(id).processing).rows.at(-1);
    const member = memberOf(id, /** @type {string} */ (range?.member));
    const menu = menuOf(aiOf(id, HOST_STATE).rows.at(-1)?.end);
    assert.deepEqual(menu.choices.map((/** @type {any} */ choice) => choice.do),
      (member.steps ?? []).map(step => ({ host: { act: 'setting', connector: id, member: member.key, value: step.value } })));
    const held = String(member.value);
    assert.deepEqual(menu.date, { label: 'A date', connector: id, member: member.key, asks: true, said: null,
      value: /^\d{4}-\d{2}-\d{2}$/u.test(held) && !(member.steps ?? []).some(step => step.value === held) ? held : '' });
    assert.deepEqual(aiOf(id, null).rows.at(-1)?.end, { words: member.words }, `${id}: Range words in a browser`);
    const markup = detailMarkup(dialog(id, null), AT_REST);
    assert.equal(actsIn(markup).some(aiAct), false, `${id}: no act in a browser`);
  }
  assert.equal(menuOf(aiOf('apple-photos', HOST_STATE).rows.at(-1)?.end).date.value, '2026-01-01');
  assert.equal(menuOf(aiOf('whatsapp', HOST_STATE).rows.at(-1)?.end).date.value, '');
});

test('L5: a change settles once a report read after it holds the value the home said landed', () => {
  const reads = /** @param {import('../public/types.js').StreamsReport} report */ report => ({ report, models: null, hiding: null });
  const act = /** @type {const} */ ({ act: 'setting', connector: 'whatsapp', member: 'llm.photos', value: 'off' });
  const sent = /** @type {import('../public/ui/connectors/pending.js').Pending} */ (pendingOf(act, reads(LLM_REPORT)));
  assert.equal(landedOf(sent, {}), sent, 'no landed: a report read after the save settles it');
  const change = landedOf(sent, { landed: { connector: 'whatsapp', member: 'llm.photos', value: 'off' } });
  assert.equal(settled(change, reads(LLM_REPORT)), false);
  /** @param {string} key @param {string} value */
  const moved = (key, value) => ({ ...LLM_REPORT, connectors: LLM_REPORT.connectors.map(each => each.id !== 'whatsapp' ? each
    : { ...each, members: each.members.map(member => member.key === key ? { ...member, value } : member) }) });
  assert.equal(settled(change, reads(moved('llm.photos', 'default'))), false, 'a read that does not hold it yet');
  assert.equal(settled(change, reads(moved('llm.photos', 'off'))), true);
  assert.equal(settled(sent, reads(LLM_REPORT)), false);
  assert.equal(settled(sent, reads(moved('llm.photos', 'default'))), true);
});

test('L6: Settings opens at the page its id names, AI models marked in its list; AI models in its order, reading, failed', () => {
  assert.equal(shownPage('settings'), 'home', 'Settings alone is Home');
  assert.equal(shownPage(SETTINGS_MODELS), 'models');
  assert.equal(shownPage('settings/general'), '', 'General is gone, with no redirect');
  for (const id of ['settings', SETTINGS_MODELS]) assert.ok(isSettings(id));
  assert.equal(isSettings('screen'), false);

  const models = settings({});
  assert.equal(models.name, 'AI models');
  const items = models.nav?.groups.flatMap(group => group.items) ?? [];
  assert.deepEqual(items.filter(each => each.on).map(each => [each.label, each.do]), [['AI models', { open: SETTINGS_MODELS }]]);
  assert.deepEqual(partLabels(models), ['Subscriptions', 'API keys', 'On this Mac', 'On Mac mini', 'On iMac', 'Defaults']);
  assert.equal(models.foot, null);
  assert.equal(settings({ id: 'settings/general' }), null);

  const reading = settings({ models: null });
  assert.equal(reading.reading, true);
  assert.deepEqual(partLabels(reading), ['Subscriptions'], 'the host\'s, drawn while the models read is not');
  const failed = settings({ models: null, failed: READ_FAILED });
  assert.equal(failed.reading, false);
  assert.equal(failed.readFailed?.drawn, READ_FAILED);
  const stale = settings({ failed: READ_FAILED });
  assert.ok(detailMarkup(stale, AT_REST).includes(LACKS.models));
  assert.deepEqual(partLabels(stale), partLabels(models), 'what was shown stays');
  assert.deepEqual(actsIn(detailMarkup(stale, AT_REST)).filter(act => 'host' in act || 'save' in act || 'page' in act), [],
    'no control acts on what may have changed');
});

test('L7: API keys: OpenRouter typed and saved, Connected and Remove; the address on its page, set and removed', () => {
  const bare = settings({ models: MODELS_BARE });
  const openrouter = rowIn(bare, 'API keys', 'OpenRouter');
  assert.equal(openrouter?.line, 'Pay per call with your own key.');
  const end = /** @type {any} */ (openrouter?.end);
  assert.deepEqual([end.field.key, end.field.kind, end.field.value], [TYPED.key, 'secret', '']);
  assert.deepEqual(end.acts.map((/** @type {any} */ act) => [act.label, act.disabled, act.do]), [['Save', true, { save: 'openrouter' }]]);
  const typed = { ...OPENED, fields: { [TYPED.key]: ' sk-or-example ' } };
  assert.equal(/** @type {any} */ (rowIn(settings({ models: MODELS_BARE, opened: typed }), 'API keys', 'OpenRouter')?.end).acts[0].disabled, false);
  assert.deepEqual(savedAct('openrouter', typed), { act: 'seal', secret: 'openrouter', value: 'sk-or-example' });
  assert.equal(savedAct('openrouter', OPENED), null);

  const custom = rowIn(bare, 'API keys', 'Custom server');
  assert.deepEqual([custom?.line, /** @type {any} */ (custom?.end).words, endActs(custom)],
    ['Any server that speaks the OpenAI API, such as Ollama or LM Studio.', 'Not set', [['Add server', { page: 'address' }]]]);
  const page = settings({ models: MODELS_BARE, opened: { ...OPENED, pages: ['address'] } });
  assert.deepEqual([page.name, page.back], ['AI models', { label: 'AI models' }]);
  assert.deepEqual(part(page, 'Custom server')?.acts.map(act => [act.label, act.disabled, act.do]), [['Save', true, { save: 'address' }]]);
  const address = { ...OPENED, pages: ['address'], fields: { [TYPED.url]: 'http://127.0.0.1:11434/v1', [TYPED.model]: 'llava:13b',
    [TYPED.takes]: 'pictures' } };
  assert.deepEqual(savedAct('address', address), { act: 'models', do: 'address', url: 'http://127.0.0.1:11434/v1', model: 'llava:13b',
    kinds: ['pictures'] });
  assert.deepEqual(savedAct('address', { ...address, fields: { ...address.fields, [TYPED.takes]: '' } })?.kinds, ['pictures', 'text'],
    'Takes defaults to pictures and text');
  assert.equal(savedAct('address', { ...address, fields: { [TYPED.url]: 'http://x' } }), null);

  const full = settings({});
  const connected = rowIn(full, 'API keys', 'OpenRouter');
  assert.deepEqual([connected?.line, /** @type {any} */ (connected?.end).words, endActs(connected)],
    ['Pay per call with your own key.', 'Connected', [['Remove', { host: { act: 'seal', secret: 'openrouter', value: null } }]]]);
  const set = rowIn(full, 'API keys', 'Custom server');
  assert.deepEqual([set?.line, set?.only, endActs(set)], [MODELS.address?.words, MODELS.address?.takes,
    [['Remove', { host: { act: 'models', do: 'address', none: true } }]]]);
  const worded = settings({ models: { ...MODELS, address: { url: 'http://x', model: 'm', words: 'Said by the home', takes: 'Takes it' } } });
  assert.deepEqual([rowIn(worded, 'API keys', 'Custom server')?.line, rowIn(worded, 'API keys', 'Custom server')?.only],
    ['Said by the home', 'Takes it']);
});

test('L7b: API keys: Cloudflare on its own page, its account ID and token sealed as one key, Connected and Remove', () => {
  const line = 'Pay per call from your Cloudflare credits, for models from OpenAI, Anthropic, Google and Workers AI.';
  const bare = rowIn(settings({ models: MODELS_BARE }), 'API keys', 'Cloudflare');
  assert.deepEqual([bare?.line, /** @type {any} */ (bare?.end).words, endActs(bare)], [line, 'Not set', [['Add account', { page: 'cloudflare' }]]]);
  const page = settings({ models: MODELS_BARE, opened: { ...OPENED, pages: ['cloudflare'] } });
  assert.deepEqual([page.name, page.back], ['AI models', { label: 'AI models' }]);
  assert.deepEqual(part(page, 'Cloudflare')?.acts.map(act => [act.label, act.disabled, act.do]), [['Save', true, { save: 'cloudflare' }]]);
  const account = '0123456789ABCDEF0123456789ABCDEF';
  const typed = { ...OPENED, pages: ['cloudflare'], fields: { [TYPED.account]: ` ${account} `, [TYPED.token]: ' synthetic-token_0001 ' } };
  assert.equal(part(settings({ models: MODELS_BARE, opened: typed }), 'Cloudflare')?.acts[0]?.disabled, false);
  assert.deepEqual(savedAct('cloudflare', typed), { act: 'seal', secret: 'cloudflare', value: `${account.toLowerCase()}:synthetic-token_0001` });
  for (const fields of [{}, { [TYPED.account]: 'not-an-account', [TYPED.token]: 't' }, { [TYPED.account]: account }, { [TYPED.account]: account, [TYPED.token]: 'two words' }]) {
    assert.equal(savedAct('cloudflare', { ...OPENED, fields }), null);
  }
  const connected = rowIn(settings({ models: { ...MODELS_BARE, cloudflare: { connected: true } } }), 'API keys', 'Cloudflare');
  assert.deepEqual([/** @type {any} */ (connected?.end).words, endActs(connected)], ['Connected', [['Remove', { host: { act: 'seal', secret: 'cloudflare', value: null } }]]]);
});

test('L8: each model file\'s act its state\'s, its progress, size and failure said; a runner away acts on nothing', () => {
  const full = settings({});
  /** @param {import('../public/ui/connectors/dialog.js').DetailPart | undefined} at */
  const files = at => (at?.panel?.rows ?? []).filter(row => row.label !== 'Run models' && row.label !== 'Save battery');
  const ACTS = /** @type {const} */ ({ absent: ['Download', 'fetch'], fetching: ['Cancel', 'remove'], ready: ['Remove', 'remove'],
    failed: ['Try again', 'fetch'] });
  /** @param {import('../public/types.js').ModelRunner} runner */
  const drawn = runner => runner.files.map(each => [each.name, each.about, each.line ?? '',
    [[ACTS[each.state][0], { host: { act: 'models', do: 'file', runner: runner.unit, id: each.id, to: ACTS[each.state][1] } }]]]);
  const [mac, mini, imac] = MODELS.runners;
  assert.deepEqual(mac.files.map(each => each.state), ['ready', 'fetching', 'absent'], 'the fixture holds three states');
  assert.deepEqual(files(part(full, 'On this Mac')).map(row => [row.label, row.line, row.only, endActs(row)]),
    drawn(mac));
  assert.deepEqual(files(part(full, 'On Mac mini')).map(row => [row.label, row.line, row.only, endActs(row)]),
    drawn(mini));
  const said = settings({ models: { ...MODELS, runners: [{ ...mac,
    files: mac.files.map((each, at) => ({ ...each, line: at === 1 ? 'Half way there' : null })) }] } });
  assert.deepEqual(files(part(said, 'On this Mac')).map(row => row.only), ['', 'Half way there', '']);
  assert.deepEqual(part(full, 'On iMac')?.panel?.rows.map(row => [row.label, endActs(row)]), [[imac.line, []]]);
  const bare = settings({ models: { ...MODELS, runners: [{ ...mac, line: 'Said by the home' }] } });
  assert.deepEqual(part(bare, 'On this Mac')?.lines, ['Said by the home']);
  assert.deepEqual(files(part(bare, 'On this Mac')).flatMap(endActs), [], 'a runner away: no act');
});

test('L8b: a runner\'s calls: Run models, its switch first where one file is ready or a pause stands, off with the home\'s words of the pause; none ready, none; in a browser its words', () => {
  const [mac] = MODELS.runners;
  /**
   * @param {Detail} detail
   * @param {string} label
   */
  const run = (detail, label) => {
    const row = part(detail, label)?.panel?.rows[0];
    return row?.label === 'Run models' ? [row.line, /** @type {any} */ (row.end)?.toggle ?? /** @type {any} */ (row.end)?.words] : null;
  };
  /** @param {'pause' | 'resume'} to */
  const act = to => ({ host: { act: 'models', do: 'runner', runner: mac.unit, to } });
  const running = settings({});
  assert.equal(mac.paused, null, 'the fixture\'s runner runs unpaused');
  assert.deepEqual(run(running, 'On this Mac'), ['Turn off to hold their work until you turn it back on.',
    { on: true, label: 'Run models', do: act('pause') }]);
  const paused = settings({ models: { ...MODELS, runners: [{ ...mac, paused: 'Said by the home' }] } });
  assert.deepEqual(run(paused, 'On this Mac'), ['Said by the home', { on: false, label: 'Run models', do: act('resume') }]);
  assert.deepEqual((part(paused, 'On this Mac')?.panel?.rows ?? []).filter(row => mac.files.some(file => file.name === row.label)).map(row => endActs(row).length), mac.files.map(() => 1));
  const unready = settings({ models: { ...MODELS, runners: [{ ...mac, files: mac.files.map(file => ({ ...file, state: file.state === 'ready' ? 'absent' : file.state })) }] } });
  assert.equal(run(unready, 'On this Mac'), null);
  assert.equal(run(running, 'On iMac'), null);
  assert.deepEqual(run(running, 'On Mac mini')?.[1], { on: false, label: 'Run models', do: { host: { act: 'models', do: 'runner',
    runner: MODELS.runners[1].unit, to: 'resume' } } });
  assert.deepEqual(run(settings({ state: null }), 'On MacBook Pro')?.[1], 'On');
  assert.deepEqual(run(settings({ failed: READ_FAILED }), 'On this Mac')?.[1], 'On');
  assert.ok(actsIn(detailMarkup(running, AT_REST)).some(each => JSON.stringify(each) === JSON.stringify(act('pause'))));
  const pending = /** @type {any} */ (pendingOf(act('pause').host, { report: null, models: MODELS, hiding: null }));
  assert.equal(keyOf(act('pause').host), keyOf(act('resume').host));
  assert.equal(settled(pending, { report: null, models: MODELS, hiding: null }), false);
  assert.equal(settled(pending, { report: null, hiding: null, models: { ...MODELS, runners: [{ ...mac, paused: 'Said by the home' }, ...MODELS.runners.slice(1)] } }), true);
});

test('L8c: a runner\'s Save battery: after Run models where its machine has a battery, on by default; on battery and on, the home\'s words of why its older work waits the part\'s line; in a browser its words', () => {
  const [mac] = MODELS.runners;
  /**
   * @param {Detail} detail
   * @param {string} label
   */
  const save = (detail, label) => {
    const rows = part(detail, label)?.panel?.rows ?? [];
    const row = rows.find(each => each.label === 'Save battery');
    return row ? [rows.indexOf(row), row.line, /** @type {any} */ (row.end)?.toggle ?? /** @type {any} */ (row.end)?.words] : null;
  };
  /** @param {'save' | 'spend'} to */
  const act = to => ({ host: { act: 'models', do: 'battery', runner: mac.unit, to } });
  /** @param {import('../public/types.js').ModelRunner['battery']} battery */
  const with_ = battery => settings({ models: { ...MODELS, runners: [{ ...mac, battery }, ...MODELS.runners.slice(1)] } });
  assert.deepEqual(mac.battery, { on: true, held: null }, 'the home\'s fixture: on, by default, on mains');
  assert.deepEqual(save(settings({}), 'On this Mac'), [1, SAVE_BATTERY, { on: true, label: 'Save battery', do: act('spend') }]);
  assert.deepEqual(part(settings({}), 'On this Mac')?.lines, []);
  const held = with_({ on: true, held: 'Said by the home' });
  assert.deepEqual(part(held, 'On this Mac')?.lines, ['Said by the home']);
  assert.deepEqual(save(with_({ on: false, held: null }), 'On this Mac')?.[2], { on: false, label: 'Save battery', do: act('save') });
  assert.equal(save(settings({}), 'On Mac mini'), null);
  assert.equal(save(settings({}), 'On iMac'), null);
  const unready = settings({ models: { ...MODELS, runners: [{ ...mac, files: mac.files.map(file => ({ ...file, state: file.state === 'ready' ? 'absent' : file.state })) }, ...MODELS.runners.slice(1)] } });
  assert.deepEqual(save(unready, 'On this Mac')?.slice(0, 2), [0, SAVE_BATTERY]);
  assert.deepEqual(save(settings({ state: null }), 'On MacBook Pro')?.[2], 'On');
  const pending = /** @type {any} */ (pendingOf(act('spend').host, { report: null, models: MODELS }));
  assert.equal(keyOf(act('spend').host), keyOf(act('save').host));
  assert.equal(settled(pending, { report: null, models: MODELS }), false);
  assert.equal(settled(pending, { report: null, models: { ...MODELS, runners: [{ ...mac, battery: { on: false, held: null } }, ...MODELS.runners.slice(1)] } }), true);
});

test('L9: Defaults: each kind a menu of the home\'s steps in the home\'s words, each sending its route, the one held checked; Pictures and Audio open with the home\'s Off', () => {
  const full = settings({});
  for (const [kind, label] of /** @type {const} */ ([['pictures', 'Pictures'], ['audio', 'Audio'], ['text', 'Text']])) {
    const choice = MODELS.defaults[kind];
    const menu = menuOf(rowIn(full, 'Defaults', label)?.end);
    assert.equal(menu.words, choice.words);
    assert.deepEqual(menu.choices.map((/** @type {any} */ each) => [each.words, each.note, each.chosen, each.do]),
      choice.steps.map(step => [step.words, step.note ?? '', step.value === choice.value,
        { host: { act: 'models', do: 'default', kind, route: step.value } }]));
  }
  assert.deepEqual([MODELS.defaults.pictures.steps[0], MODELS.defaults.audio.steps[0]].map(step => step.words), ['Off', 'Off'], 'the home lists Off first');
  assert.notEqual(MODELS.defaults.pictures.value, MODELS.defaults.pictures.steps[0].value, 'a picked Pictures offers Off to go back to');
  assert.equal(MODELS.defaults.audio.words, 'Off');
  assert.equal(MODELS.defaults.text.steps.some(step => step.words === 'Off'), false);
  assert.equal(menuOf(rowIn(full, 'Defaults', 'Audio')?.end).choices.filter((/** @type {any} */ each) => each.words === 'Off').length, 1, 'Off once');
  assert.equal(menuOf(rowIn(full, 'Defaults', 'Text')?.end).choices.some((/** @type {any} */ each) => each.chosen), false);
  assert.equal(rowIn(settings({ state: null }), 'Defaults', 'Audio')?.end?.words, 'Off', 'without acts it reads Off too');

  const offStep = MODELS.defaults.pictures.steps[0];
  const off = /** @type {any} */ (pendingOf({ act: 'models', do: 'default', kind: 'pictures', route: offStep.value }, { report: null, models: MODELS, hiding: null }));
  assert.equal(settled(off, { report: null, models: MODELS, hiding: null }), false);
  const cleared = { ...MODELS, defaults: { ...MODELS.defaults, pictures: { ...MODELS.defaults.pictures, value: offStep.value } } };
  assert.equal(settled(off, { report: null, models: cleared, hiding: null }), true, 'Off lands when the home reads Off');
});

test('L10: General is gone: This Mac\'s Open at login, Updates and Uninstall, each toggle sending the value it would take', () => {
  const mac = settings({ id: 'settings/mac' });
  const login = rowIn(mac, 'MacBook Pro', 'Open at login') ?? rowIn(mac, '', 'Open at login');
  assert.equal(login?.line, 'So this Mac records and syncs after a restart.');
  assert.deepEqual(/** @type {any} */ (login?.end).toggle.do, { host: { act: 'general-login', on: false } });
  assert.deepEqual(endActs(rowIn(mac, 'Uninstall', 'Uninstall Lifestream')), [['Uninstall…', { host: { act: 'uninstall' } }]]);
  assert.equal(rowIn(mac, 'Uninstall', 'Uninstall Lifestream')?.line,
    'Removes the app from this Mac. Lifestream is kept unless you choose to erase it.');
  const updates = settings({ id: 'settings/updates' });
  const version = rowIn(updates, '', 'Version');
  assert.deepEqual([/** @type {any} */ (version?.end).words, version?.line, endActs(version)],
    ['2026.11.10', '', [['Check for Updates…', { host: { act: 'general-check' } }]]]);
  const auto = rowIn(updates, '', 'Install updates automatically');
  assert.equal(auto?.line, 'Lifestream restarts into an update while your screen is locked.');
  assert.deepEqual(/** @type {any} */ (auto?.end).toggle.do, { host: { act: 'general-auto-update', on: false } });
  const general = { login: false, auto_update: false, version: '2026.11.10', update: 'Lifestream 2026.11.12 is ready', by_hand: null };
  assert.equal(rowIn(settings({ id: 'settings/updates', state: { ...HOST_STATE, general } }), '', 'Version')?.line,
    'Lifestream 2026.11.12 is ready');
  const off = settings({ id: 'settings/mac', state: { ...HOST_STATE, general } });
  assert.deepEqual(/** @type {any} */ ((rowIn(off, 'MacBook Pro', 'Open at login') ?? rowIn(off, '', 'Open at login'))?.end).toggle.do,
    { host: { act: 'general-login', on: true } });
  assert.equal(settings({ id: 'settings/updates', state: null }), null);
});

test('L11: in a browser no act on any Settings page, its note saying where they are made', () => {
  for (const models of [MODELS, MODELS_BARE]) {
    const detail = settings({ models, state: null });
    const markup = detailMarkup(detail, AT_REST);
    assert.equal(detail.note, NOTES.browser, 'where it is done');
    assert.equal(markup.replace(/<[^>]*>/gu, ' ').split(esc(NOTES.browser)).length - 1, 1, 'said once, at the page\'s top');
    assert.deepEqual(actsIn(markup).filter(act => 'host' in act || 'save' in act || 'page' in act), []);
    const plans = [...markup.matchAll(/<button[^>]*data-flow="[^"]*"[^>]*>/gu)].map(match => match[0]);
    assert.equal(plans.length, 2);
    for (const each of plans) assert.ok(each.includes('disabled') && each.includes(`title="${esc(ELSEWHERE)}"`), each);
  }
});

test('L12: made: the home\'s line (who wrote it and when, once answered; why, until then), its act with a host, an ask and steps', () => {
  /** @param {any} what @param {boolean} acts */
  const draw = (what, acts, verbs = DESCRIBE) => made({ made: what, verbs, acts, id: 'x', attrs: { 'data-t': '' } });
  const again = draw(DESCRIBED.again, true);
  assert.ok(again.includes(`<p class="ck-made__line mac-subhead">${esc(/** @type {string} */ (DESCRIBED.again.line))}</p>`),
    'the home\'s line of who wrote it');
  assert.equal(draw({ ...DESCRIBED.again, line: null }, true).includes('ck-made__line'), false, 'no line: none made here');
  assert.ok(again.includes('Describe again'));
  assert.deepEqual([...again.matchAll(/data-value="([^"]*)"/gu)].map(match => match[1]), DESCRIBED.again.choose.map(step => step.value));
  assert.equal(draw({ ...DESCRIBED.done, choose: [] }, true).includes('<button'), false);
  for (const what of [DESCRIBED.off, DESCRIBED.older, DESCRIBED.queued, DESCRIBED.failed]) {
    const now = draw(what, true);
    const [step] = what.choose;
    assert.ok(/>Describe now</u.test(now), what.state);
    assert.ok(now.includes(`<p class="ck-made__to mac-subhead">${esc(`${step.words} · ${step.note}`)}</p>`), 'its model and where it goes');
    assert.deepEqual([...now.matchAll(/data-value="([^"]*)"/gu)].map(match => match[1]), [step.value]);
    if (what.line) assert.ok(now.includes(esc(what.line)), `${what.state}: the home's line`);
  }
  for (const what of [DESCRIBED.needs, DESCRIBED.resting]) {
    const markup = draw(what, true);
    assert.ok(markup.includes(esc(/** @type {string} */ (what.line))));
    assert.equal(markup.includes('<button'), false);
  }
  assert.equal(draw(DESCRIBED.again, false).includes('<button'), false);
  assert.equal(draw(DESCRIBED.none, true), '', 'nothing asked of it: nothing drawn');
  assert.equal(draw(null, true), '');
  assert.ok(draw(TRANSCRIBED.again, true, TRANSCRIBE).includes('Transcribe again'));
  assert.ok(/>Transcribe now</u.test(draw(TRANSCRIBED.queued, true, TRANSCRIBE)));
});

test('L17: OpenRouter is connected when the models read says so, and only then', () => {
  const state = { ...HOST_STATE, ask_login: SUBSCRIBED.none };
  /** @param {{ connected: boolean }} openrouter */
  const model = openrouter => modelOf({ report: null, state, models: { ...MODELS_BARE, openrouter } });
  assert.deepEqual([model({ connected: false }).openrouter, model({ connected: false }).connected], [false, false]);
  assert.deepEqual([model({ connected: true }).openrouter, model({ connected: true }).connected], [true, true]);
  assert.equal(modelOf({ report: null, state, models: null }).connected, false);
  assert.equal(modelOf({ report: null, state }).connected, false);
  const signedIn = modelOf({ report: null, state: { ...HOST_STATE, ask_login: SUBSCRIBED.mixed }, models: MODELS_BARE });
  assert.deepEqual([signedIn.openrouter, signedIn.connected], [false, true]);
});

test('L13: no barred word anywhere this lane draws', () => {
  /** @param {string} markup */
  const shown = markup => markup.replace(/<[^>]*>/gu, ' ').replaceAll('&amp;', '&').replaceAll('&#39;', '’');
  /** @param {Panel} each */
  const menus = each => each.rows.flatMap(row => {
    const menu = menuOf(row.end);
    return menu ? [menu.label, menu.words, ...menu.choices.flatMap((/** @type {any} */ choice) => [choice.words, choice.note])] : [];
  });
  const pages = [
    ...SHAPED.flatMap(id => [dialog(id, HOST_STATE), dialog(id, null)].map(detail => /** @type {Detail} */ ({ ...detail, reads: '',
      panels: detail.panels.filter(each => each.label === 'AI') }))),
    ...SHAPED.flatMap(id => worksOf(id).flatMap(row => [pageOf(id, row.member, HOST_STATE), pageOf(id, row.member, null)])),
    settings({}), settings({ models: MODELS_BARE }), settings({ state: null }),
    settings({ failed: READ_FAILED }), settings({ models: MODELS_BARE, opened: { ...OPENED, pages: ['address'] } }),
  ];
  for (const detail of pages) {
    const markup = detailMarkup(detail.panels.length || detail.parts.length ? detail : { ...detail, nav: null }, AT_REST);
    const words = [shown(markup), ...detail.panels.flatMap(menus), ...detail.parts.flatMap(each => each.panel ? menus(each.panel) : [])];
    for (const each of words) assert.doesNotMatch(each.replaceAll(RUN_LINE, ''), BARRED, `${detail.id}: "${each.slice(0, 120)}"`);
  }
  for (const what of [...Object.values(DESCRIBED), ...Object.values(TRANSCRIBED)]) {
    const markup = made({ made: what, verbs: DESCRIBE, acts: true, id: 'x' });
    assert.doesNotMatch(shown(markup), BARRED);
  }
});

test('L14: a change waits by what it changes until the read authoritative for it says it', () => {
  /** @param {Partial<import('../public/ui/connectors/pending.js').Reads>} more */
  const reads = more => ({ report: LLM_REPORT, models: MODELS, hiding: null, ...more });
  const MAC = MODELS.runners[0];
  const ABSENT = /** @type {import('../public/types.js').ModelFile} */ (MAC.files.find(file => file.state === 'absent'));
  const text = /** @type {const} */ ({ act: 'models', do: 'default', kind: 'text' });
  assert.equal(keyOf({ ...text, route: 'openrouter:google/gemini-3-flash' }), keyOf({ ...text, route: 'runner:qwen3.5' }));
  assert.equal(keyOf({ ...text, route: 'runner:qwen3.5' }), thingKey({ kind: 'default', of: 'text' }), 'the key its menu waits on');
  const fileKey = keyOf({ act: 'models', do: 'file', runner: MAC.unit, id: ABSENT.id, to: 'fetch' });
  assert.equal(fileKey, keyOf({ act: 'models', do: 'file', runner: MAC.unit, id: ABSENT.id, to: 'remove' }));
  assert.equal(keyOf({ act: 'seal', secret: 'openrouter', value: 'x' }), keyOf({ act: 'seal', secret: 'openrouter', value: null }));
  assert.equal(keyOf({ act: 'general-check' }), null);
  const slashed = /** @type {any} */ (pendingOf({ act: 'models', do: 'file', runner: MAC.unit, id: 'vendor/model', to: 'fetch' },
    reads({})));
  assert.deepEqual(slashed.thing, { kind: 'file', runner: MAC.unit, id: 'vendor/model' });
  assert.equal(actKey({ act: 'choose-app' }, { connector: 'screen', member: 'apps' }), 'setting:screen.apps');
  assert.equal(actKey({ act: 'general-check' }), JSON.stringify({ act: 'general-check' }));

  const fetch = /** @type {import('../public/ui/connectors/pending.js').Pending} */ (pendingOf({ act: 'models', do: 'file',
    runner: MAC.unit, id: ABSENT.id, to: 'fetch' }, reads({})));
  assert.equal(settled(fetch, reads({})), false, 'the host answered, the read still says absent');
  /** @param {string} state */
  const nemotron = state => ({ ...MODELS, runners: MODELS.runners.map(runner => ({ ...runner, files: runner.files.map(file =>
    file.id === ABSENT.id ? { ...file, state: /** @type {any} */ (state) } : file) })) });
  assert.equal(settled(fetch, reads({ models: nemotron('fetching') })), true);
  assert.equal(settled(fetch, reads({ models: nemotron('ready') })), true);
  assert.equal(settled(fetch, reads({ models: null })), false, 'a failed read lands nothing');

  const chosen = /** @type {any} */ (pendingOf({ ...text, route: 'runner:qwen3.5' }, reads({})));
  const textAt = (/** @type {string | null} */ value) => ({ ...MODELS, defaults: { ...MODELS.defaults, text: { ...MODELS.defaults.text, value,
    steps: [] } } });
  assert.equal(settled(chosen, reads({ models: textAt(null) })), false);
  assert.equal(settled(chosen, reads({ models: textAt('runner:qwen3.5') })), true);
  assert.equal(settled(chosen, reads({ models: textAt('openrouter:google/gemini-3-flash') })), true, 'changed elsewhere');

  assert.equal(pendingOf({ act: 'general-login', on: false }, reads({})), null);
  assert.equal(keyOf({ act: 'general-auto-update', on: true }), null);

  const key = /** @type {any} */ (pendingOf({ act: 'seal', secret: 'openrouter', value: null }, reads({})));
  assert.equal(settled(key, reads({})), false);
  assert.equal(settled(key, reads({ models: { ...MODELS, openrouter: { connected: false } } })), true);

  const address = /** @type {any} */ (pendingOf({ act: 'models', do: 'address', url: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:4b',
    kinds: ['text'] }, reads({ models: MODELS_BARE })));
  assert.equal(settled(address, reads({ models: MODELS_BARE })), false);
  assert.equal(settled(address, reads({ models: { ...MODELS_BARE, address: { url: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:4b',
    words: 'qwen3.5:4b at http://127.0.0.1:11434/v1', takes: 'Takes text' } } })), true);
  const stopped = { ...MODELS, runners: MODELS.runners.map(runner => ({ ...runner, line: 'Said by the home' })) };
  assert.equal(settled(fetch, reads({ models: stopped })), true);

  const defaults = settings({ models: textAt(null) });
  const busy = { ...AT_REST, busy: new Set([/** @type {string} */ (keyOf({ ...text, route: 'runner:qwen3.5' }))]) };
  assert.ok(/<button[^>]*aria-busy="true"[^>]*aria-label="Text: No model yet"/u.test(detailMarkup(defaults, busy)), 'the Text menu waits');
  const stream = /** @type {Detail} */ (detailOf(LLM_REPORT, HOST_STATE, 'whatsapp', OPENED));
  const member = { ...AT_REST, busy: new Set(['setting:whatsapp.llm.range']) };
  assert.ok(detailMarkup(stream, member).match(/<button[^>]*aria-busy="true"[^>]*aria-label="([^"]*)"/u)?.[1]
    === esc(`${memberOf('whatsapp', 'llm.range').label}: ${memberOf('whatsapp', 'llm.range').words}`));
});

test('L15: Range\'s date says what it would read before it is sent, one act sending it', () => {
  /** @param {Partial<import('../public/ui/connectors/dialog.js').Dated>} dated */
  const range = dated => menuOf(/** @type {Panel} */ (panel(/** @type {Detail} */ (detailOf(LLM_REPORT, HOST_STATE, 'whatsapp',
    { ...OPENED, dated: { connector: 'whatsapp', member: 'llm.range', value: RANGE_STEP.value, step: null, failed: '', ...dated } })),
  'AI')).rows.at(-1)?.end).date;
  assert.deepEqual(range({}), { label: 'A date', value: RANGE_STEP.value, connector: 'whatsapp', member: 'llm.range', asks: true,
    said: { note: 'Reading what it would read…', act: null } }, 'asked: nothing to send yet');
  assert.deepEqual(range({ step: RANGE_STEP }).said, { note: RANGE_STEP.note, act: { label: 'Back to 3 Mar 2024', variant: 'primary',
    do: { host: { act: 'setting', connector: 'whatsapp', member: 'llm.range', value: RANGE_STEP.value } } } });
  assert.deepEqual(range({ failed: 'Can’t reach Lifestream.' }).said, { note: 'Can’t reach Lifestream.', act: null });
  assert.equal(range({ connector: 'gmail' }).said, null);
});

test('L16: Settings\' Subscriptions are the model flow\'s two items, ChatGPT and Claude, as the flow draws them', () => {
  assert.deepEqual([...MODEL_ITEMS], ['chatgpt', 'claude'], 'no OpenRouter item: its key is Settings\' Keys');
  assert.deepEqual([...SUBSCRIPTIONS], ['chatgpt', 'claude']);
  /** @param {any} login */
  const drawn = login => {
    const state = { ...HOST_STATE, ask_login: login };
    const detail = settings({ state, subscriptions: plansOf(state) });
    const plans = /** @type {any} */ (part(detail, 'Subscriptions'));
    assert.deepEqual(plans.flow, plansOf(state));
    assert.ok(flowPageRows(plans.flow).every(row => detailMarkup(detail, AT_REST).includes(row)), 'its items as its rows');
    return plans.flow.lists[0].items.map((/** @type {any} */ item) => [item.name, item.line, item.act?.label ?? '']);
  };
  assert.deepEqual(drawn(SUBSCRIBED.none), [['ChatGPT', 'Use your ChatGPT plan.', 'Connect'], ['Claude', 'Use your Claude plan.', 'Connect']]);
  assert.deepEqual(drawn(SUBSCRIBED.mixed), [['ChatGPT', 'Getting Codex to sign in, 120 of 347 MB.', ''],
    ['Claude', 'person-a@example.com · Max plan', 'Sign out']]);
  assert.deepEqual(drawn(SUBSCRIBED.signing).map(([name, line, act]) => [name, line, act]), [
    ['ChatGPT', 'Enter this code on OpenAI’s page.', 'Open sign-in page'],
    ['Claude', 'Approve on Anthropic’s page. If it shows a code, paste it here.', 'Open sign-in page']]);
  assert.deepEqual(drawn(SUBSCRIBED.failed), [['ChatGPT', 'Sign in with your ChatGPT plan.', 'Sign in'], ['Claude', '', 'Try again']]);
  assert.equal(part(settings({ subscriptions: null }), 'Subscriptions'), undefined);
});

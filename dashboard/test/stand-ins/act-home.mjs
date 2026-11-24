// @ts-check
import { createServer } from 'node:http';

export const ENDED = 'poll';

/** @param {{ door: { url: string, token: string } | null, importing: string }} options */
export async function actHome({ door, importing }) {
  /** @param {string} id @param {string} name @param {string} next @param {Record<string, string>} [more] */
  const stopped = (id, name, next, more = {}) => ({ id, kind: 'stopped', what: `Couldn’t sync ${name}`, next,
    acts: [{ do: 'try', label: 'Try now' }], urgency: 'today', device: 'mac', since_ms: Date.now() - 50 * 60_000, ...more });
  const first = () => new Map([
    ['poll:gmail-imap', stopped('poll:gmail-imap', 'Gmail', 'Lifestream tries again in 12 min.')],
    ['poll:chatgpt-browser', stopped('poll:chatgpt-browser', 'ChatGPT', 'Lifestream tries again in 4 min.',
      { site: 'chatgpt' })],
    [`job:import:${importing}`, { id: `job:import:${importing}`, kind: 'stopped',
      what: 'Couldn’t bring in new items from Audio',
      next: 'Lifestream tries again tomorrow. Skip it to bring in what came after.', acts: [{ do: 'skip', label: 'Skip it' }],
      urgency: 'today', device: 'mac', since_ms: Date.now() - 3 * 3_600_000 }],
  ]);
  /** @type {Map<string, any>} */
  let needs = first();
  /** @type {Map<string, any>} */
  const running = new Map();
  /** @type {Record<string, string>} */
  const ROW_OF = { 'poll:gmail-imap': 'gmail', 'poll:chatgpt-browser': 'chatgpt' };
  /** @type {{ need: string, do: string, of?: string, account?: string, token: string, answered: number }[]} */
  const presses = [];
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  let seq = 0;
  const SET_UP = { gmail: 'gmail:person-a@example.com:cloud', chatgpt: 'chatgpt:user-synthetic0001:browser' };
  /** @param {string} path */
  const fromDoor = async path => door ? fetch(`${door.url}${path}`, { headers: { authorization: `Bearer ${door.token}` } })
    : null;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '', 'http://door').pathname;
    /** @param {number} status @param {unknown} body */
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (path === '/v1/feed') {
      feeds.add(response);
      response.on('close', () => feeds.delete(response));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 1000\n\n');
      return;
    }
    if (path === '/v1/act' && request.method === 'POST') {
      let text = '';
      for await (const chunk of request) text += chunk;
      const { need, do: doing, of, account } = JSON.parse(text);
      const held = needs.get(need);
      const offered = doing === 'try' && held?.acts?.some((/** @type {{ do: string }} */ act) => act.do === doing) === true;
      presses.push({ need, do: doing, ...of === undefined ? {} : { of }, ...account === undefined ? {} : { account },
        token: String(request.headers.authorization), answered: offered ? 200 : 409 });
      if (!offered) return send(409, { code: 'NOT_OFFERED', message: `[NOT_OFFERED] ${need} offers no ${doing}` });
      running.set(need, held);
      needs.delete(need);
      return send(200, { acted: 'queued' });
    }
    const passed = await fromDoor(request.url ?? '');
    if (path === '/v1/connectors') {
      const report = passed ? await passed.json() : { at_ms: Date.now(), day: '2026-10-15', needs: [], connectors: [] };
      const rows = /** @type {any[]} */ (report.connectors ?? []);
      /** @param {any} need */
      const rowOf = need => ROW_OF[/** @type {keyof typeof ROW_OF} */ (need.id)] ?? (need.id === `job:import:${importing}`
        ? rows.find(row => (row.copies ?? []).some((/** @type {any} */ copy) => copy.id === importing))?.id ?? null : null);
      /** @param {any} need */
      const sent = need => ({ id: need.id, state: 'broken', reason: 'failing', words: need.what, since_ms: need.since_ms,
        next_ms: null, acts: need.acts.map((/** @type {any} */ act) => ({ ...act, need: need.id })), connector: rowOf(need),
        copy: null, unit: null });
      const added = [...needs.values()].map(sent);
      /** @param {string} state @param {string} words @param {any[]} acts */
      const health = (state, words, acts = []) => ({ state, reason: null, words, since_ms: null, next_ms: null, acts });
      return send(200, { ...report, needs: [...(report.needs ?? []), ...added], connectors: rows.map(row => {
        const need = added.find(each => each.connector === row.id);
        const reading = [...running.keys()].some(id => ROW_OF[/** @type {keyof typeof ROW_OF} */ (id)] === row.id);
        const said = need ? { ...health(need.state, need.words, need.acts), reason: need.reason, since_ms: need.since_ms }
          : reading ? health('syncing', 'Reading…') : row.id in SET_UP ? health('ok', 'Nothing yet') : row.health;
        const own = { ...row, health: said, line: need || reading || row.id in SET_UP ? said.words : row.line };
        return row.id in SET_UP ? { ...own, set_up: true, lead: null, copies: [{ id: SET_UP[/** @type {keyof typeof SET_UP} */ (row.id)],
          name: row.name, road: row.roads?.[0] ?? 'poll', unit: null, on: true, retired: false, health: health('ok', 'Nothing yet'),
          held: 0, newest_ms: null, oldest_ms: null, line: 'Nothing yet' }] } : own;
      }) });
    }
    if (!passed) return send(503, { code: 'NOT_NOW', message: 'The stand-in answers only Streams.' });
    response.writeHead(passed.status, { 'content-type': passed.headers.get('content-type') ?? 'application/json' });
    response.end(Buffer.from(await passed.arrayBuffer()));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    presses,
    reset() {
      needs = first();
      running.clear();
      presses.length = 0;
    },
    /**
     * @param {string} id
     * @param {string | null} next
     */
    end(id, next) {
      const held = running.get(id) ?? needs.get(id);
      running.delete(id);
      if (next === null) needs.delete(id);
      else needs.set(id, { ...held, next, acts: [{ do: 'try', label: 'Try now' }] });
      seq += 1;
      const event = { seq, at_ms: Date.now(), kind: ENDED, key: id, detail: { error: next !== null } };
      for (const feed of feeds) feed.write(`id: act-${seq}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    async close() {
      for (const feed of feeds) feed.end();
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}

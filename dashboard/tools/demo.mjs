// @ts-check
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

export const DEMO_YOU = 'Inês Moreira';

/** @type {Record<string, string>} */
export const DEMO_PEOPLE = {
  A: 'Beatriz Antunes', B: 'Samuel Osei', C: 'Helena Vaz', D: 'Tomás Brandão', E: 'Priya Raman', F: 'Diego Salgado',
  G: 'Amara Nwosu', H: 'Margarida Leal', I: 'Karim Haddad', J: 'Jonas Weber', K: 'Sara Lindqvist', L: 'Mateus Correia',
  M: 'Aiko Nishida', N: 'Lucía Ferrán', O: 'Omar Benali', P: 'Hugo Rebelo', Q: 'Rita Calado', R: 'Pedro Amaral',
  S: 'Fatima Rahimi', T: 'Clara Bastos', U: 'Arjun Pillai', V: 'Teresa Godinho', W: 'Lukas Brandt', X: 'Marisol Ortega',
  Y: 'Ben Achterberg', Z: 'Leonor Falcão', AA: 'Yusuf Kaya', AB: 'Daniel Moura', AC: 'Elena Morozova', AD: 'Filipe Lacerda',
  AE: 'Mei Lin Chou', AF: 'Noor Shah', AG: 'Tiago Rosmaninho', AH: 'André Quintela', AJ: 'Carlos Vidal', AK: 'Vasco Simões',
  AL: 'Anja Petersen',
};

export const DEMO_MODELS = [
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', thinking: ['low', 'medium', 'high'], default: 'high', group: 'ChatGPT', photos: true },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', thinking: ['low', 'high'], default: 'high', group: 'ChatGPT', photos: true },
];

export const DEMO_NOW = Date.UTC(2026, 10, 19, 18, 40);

/** @type {{ name: string, screen: string, hash?: string, run?: string }[]} */
export const DEMO_PICTURES = [
  { name: 'timeline', screen: 'days-all-open' },
  { name: 'chat', screen: 'chat-thread-top' },
  { name: 'people', screen: 'people-list' },
  { name: 'places', screen: 'days-all-open', hash: '#view=places', run: '' },
];

const PERSON = /\bPerson ([A-Z]{1,2})\b/gu;

/** @param {string} text */
const renamed = text => text.replace(PERSON, (whole, letters) => {
  const name = DEMO_PEOPLE[letters];
  if (!name) throw new Error(`no demo name for ${whole}`);
  return name;
});

/**
 * @param {unknown} value
 * @returns {any}
 */
export const named = value => {
  if (typeof value === 'string') return renamed(value);
  if (Array.isArray(value)) return value.map(named);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, named(each)]));
  return value;
};

/**
 * @param {string} path
 * @param {URLSearchParams} query
 * @param {any} body
 */
const shaped = (path, query, body) => {
  const read = named(body);
  if (path === '/v1/people' && !query.has('id') && !query.has('q') && read.you) read.you = { ...read.you, name: DEMO_YOU };
  if (path === '/v1/connectors' && read.setup) read.setup = { ...read.setup, skipped: [...read.setup.skipped ?? [], 'imports'] };
  if (path === '/v1/places' && Array.isArray(read.places)) {
    read.spots = [];
    read.places = read.places.filter((/** @type {any} */ place) => Math.abs(place.latitude) > 1 || Math.abs(place.longitude) > 1)
      .map((/** @type {any} */ place) => {
        const { home: _home, ...rest } = place;
        return rest;
      });
  }
  return read;
};

/** @param {{ door: { url: string } }} options */
export async function demoDoor({ door }) {
  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function answer(request, response) {
    const url = new URL(request.url ?? '', 'http://door');
    /** @type {Buffer[]} */
    const body = [];
    for await (const chunk of request) body.push(chunk);
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !['host', 'connection', 'content-length'].includes(name)) headers[name] = String(value);
    }
    const passed = await fetch(`${door.url}${request.url}`, {
      method: request.method, headers, body: body.length ? Buffer.concat(body) : undefined,
    }).catch(() => null);
    if (!passed) return void response.writeHead(502).end();
    /** @type {Record<string, string>} */
    const back = {};
    passed.headers.forEach((value, name) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)) back[name] = value;
    });
    if ((passed.headers.get('content-type') ?? '').startsWith('application/json') && passed.status === 200) {
      const text = JSON.stringify(shaped(url.pathname, url.searchParams, await passed.json()));
      response.writeHead(passed.status, back);
      return void response.end(text);
    }
    response.writeHead(passed.status, back);
    if (!passed.body) return void response.end();
    const stream = Readable.fromWeb(/** @type {any} */ (passed.body));
    response.once('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }
  const server = createServer((request, response) => {
    answer(request, response).catch(() => response.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    close: () => new Promise(done => {
      server.closeAllConnections();
      server.close(() => done(undefined));
    }),
  };
}

const MINUTE = 60_000;

/**
 * @param {any} body
 * @param {number} by
 * @returns {any}
 */
const moved = (body, by) => {
  if (Array.isArray(body)) return body.map(each => moved(each, by));
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key,
    /_ms$/u.test(key) && typeof value === 'number' && key !== 'ms' ? Math.round((value + by) / MINUTE) * MINUTE : moved(value, by)]));
};

/** @param {any} body */
const asked = body => {
  if (!body || typeof body !== 'object' || !Array.isArray(body.models)) return body;
  const [first] = DEMO_MODELS;
  return { ...body, model: first.id, name: first.name, thinking: first.default, group: first.group, default: { model: first.id }, models: DEMO_MODELS };
};

/** @param {any} body */
const answeredBy = body => body && typeof body === 'object' && Array.isArray(body.messages)
  ? { ...body, messages: body.messages.map((/** @type {any} */ each) => each.model ? { ...each, model: DEMO_MODELS[0].id } : each) } : body;

/** @param {any} body */
const organised = body => {
  if (!body || typeof body !== 'object' || !Array.isArray(body.people) || !body.organise) return body;
  const people = body.people.filter((/** @type {any} */ each) => each.entity !== 'ai');
  const queue = people.slice(-4).map((/** @type {any} */ each) => each.id);
  return { ...body, people: body.people.map((/** @type {any} */ each) => queue.includes(each.id) ? { ...each, organised: false } : each),
    organise: { ...body.organise, queue, organised: people.length - queue.length, often: queue.length } };
};

/**
 * @template {{ name: string, hash: string, stub?: { url: string, json?: unknown }[], now?: number, whole?: boolean, run?: string, section: string, title: string }} Screen
 * @param {Screen[]} screens
 * @returns {Screen[]}
 */
export function demoScreens(screens) {
  const by = DEMO_NOW - Date.now();
  return DEMO_PICTURES.map(({ name, screen, hash, run }) => {
    const found = screens.find(each => each.name === screen);
    if (!found) throw new Error(`no screen ${screen} for the demo picture ${name}`);
    const stub = (found.stub ?? []).map(rule => rule.json === undefined ? rule
      : { ...rule, json: organised(answeredBy(asked(rule.url.startsWith('api/ask') ? moved(named(rule.json), by) : named(rule.json)))) });
    return { ...found, name, section: 'Demo', title: `README picture: ${name}`, hash: hash ?? found.hash, stub, now: DEMO_NOW, whole: false,
      run: run ?? found.run };
  });
}

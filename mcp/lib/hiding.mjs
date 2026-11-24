// @ts-check
import { readFileSync } from 'node:fs';
import { DoorRefusal, ToolError } from './errors.mjs';
import { GONE } from './door.mjs';
import { HANDLE, Hidden, Joined, Said } from './pieces.mjs';
import { noticed } from './shape.mjs';

export { HANDLE };

/**
 * @typedef {import('./door.mjs').Door} Door
 * @typedef {{ from: string, to: string }} Span
 * @typedef {{ json: Record<string, unknown>, images?: { data: string, mimeType: string }[], links?: string[], found?: number | string, span?: Span }} Routed
 * @typedef {{ name: string, description: string, inputSchema: any, annotations?: any, run: (args: any, context: any) => Promise<any>, route?: string, wrapped?: (args: any) => boolean, keepsUnknown?: boolean, writes?: boolean | ((args: any) => boolean), fixed?: boolean, asWritten?: boolean }} Tool
 * @typedef {{ table: string, to?: string, agent: boolean, shown?: () => string[], showed?: (words: string) => void, epoch?: number | null, ready?: (line: string, door: Door) => Promise<void> }} Under
 * @typedef {{ handle: string, title?: string }} Cited
 * @typedef {{ text: string, images: { data: string, mimeType: string }[], links: string[], found?: number | string, span?: Span, cited: Cited[] }} Run
 * @typedef {import('./pieces.mjs').Mark & { placeholder: string }} Placing
 * @typedef {{ text: string, marks: Placing[], unknown: string[], refs: { handle: string, ref: unknown }[], citations?: Record<string, import('./ask/conversations.mjs').Citation> }} Restored
 * @typedef {{ start: number, end: number, placeholder: string }} Placed
 * @typedef {string | { jpeg: string, drew: boolean } | { cannot: string }} HiddenText
 * @typedef {{ texts: HiddenText[], spans: Placed[][] }} Hid
 */

export const HIDE_NOT_READY_WORDS = 'Lifestream cannot hide personal details yet. Ask again in a few minutes.';
export const NOT_ANSWERING = 'Lifestream is not answering.';
export const HIDE_FAILED = 'Lifestream could not hide this answer. Ask again in a moment.';
const TRIES = 3;

export const AGENT = 'agent';

const PLACEHOLDERS = /\[\[[^[\]\n]*\]\]/gu;

/** @type {Record<string, string[]>} */
const ECHOES = JSON.parse(readFileSync(new URL('../../packages/home/contract/echoes.json', import.meta.url), 'utf8'));

/** @param {string} text */
const wordsOf = text => [...text.matchAll(/[\p{L}\p{N}\p{Co}]+/gu)].map(([word]) => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());

/** @param {unknown} value @param {boolean} [keys] @returns {string[]} */
const stringsIn = (value, keys = false) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(each => stringsIn(each, keys))
  : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, each]) => [...(keys ? [key] : []), ...stringsIn(each, keys)]) : []);

/** @param {unknown} value */
const wordsShown = value => [...new Set(stringsIn(value, true).flatMap(text => wordsOf(text.replace(PLACEHOLDERS, ' '))))];

/** @param {unknown} value @param {string} path */
const unsaid = (value, path) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const [head = '', ...rest] = path.split('.');
  const name = head.replace(/\[\]$/u, '');
  if (rest.length === 0) return void delete /** @type {Record<string, unknown>} */ (value)[name];
  const inner = /** @type {Record<string, unknown>} */ (value)[name];
  for (const each of Array.isArray(inner) ? inner : [inner]) unsaid(each, rest.join('.'));
};

/** @param {string} path @param {unknown} answer @returns {string[]} */
export function shownBy(path, answer) {
  const said = structuredClone(answer);
  for (const echo of ECHOES[path]) unsaid(said, echo);
  return wordsShown(said);
}

/** @param {string} text */
const parsed = text => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export class HidingFailed extends ToolError {
  /**
   * @param {string} message
   * @param {{ line?: string, unknown?: string[] }} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.line = extra.line;
    this.unknown = extra.unknown;
  }
}

class Erased extends Error {
  /** @param {number | null} epoch */
  constructor(epoch) {
    super('an erasure ran since these texts were read');
    this.epoch = epoch;
  }
}

/** @param {Under} under */
export function openWrapper(under) {
  let epoch = under.epoch ?? null;
  /** @type {unknown} */
  let level = null;

  /**
   * @param {Door} door
   * @param {string} path
   * @param {Record<string, unknown>} body
   */
  const call = async (door, path, body) => {
    for (;;) {
      try {
        const answer = await door.post(path, { table: under.table, ...body });
        if (typeof answer.epoch === 'number') epoch = answer.epoch;
        if (answer.level !== undefined) level = answer.level;
        return answer;
      } catch (error) {
        if (!(error instanceof ToolError) || error instanceof HidingFailed) throw error;
        if (!(error instanceof DoorRefusal)) throw new HidingFailed(error.message === GONE ? NOT_ANSWERING : error.message);
        if (error.status === 409 && error.code === 'ERASED') {
          const named = typeof error.body.epoch === 'number' ? error.body.epoch : null;
          if (named !== null) epoch = named;
          throw new Erased(named);
        }
        if (error.status === 503 && error.code === 'HIDE_NOT_READY') {
          await notReady(error, door);
          continue;
        }
        if (error.status === 401 || error.status === 503) throw error;
        throw new HidingFailed(HIDE_FAILED);
      }
    }
  };

  /**
   * @param {DoorRefusal} error
   * @param {Door} door
   */
  const notReady = async (error, door) => {
    if (under.ready === undefined) throw new HidingFailed(HIDE_NOT_READY_WORDS);
    await under.ready(error.said, door);
  };

  /**
   * @param {Door} door
   * @param {string} path
   * @param {Record<string, unknown>} args
   * @returns {Promise<any>}
   */
  const route = async (door, path, args) => {
    for (;;) {
      try {
        return await (under.agent ? door : door.forModel(under.table.slice('chat:'.length))).post(path, { args, to: under.to ?? AGENT, shown: under.shown?.() ?? [] });
      } catch (error) {
        if (error instanceof ToolError && !(error instanceof DoorRefusal) && error.message === GONE) throw new HidingFailed(NOT_ANSWERING);
        if (!(error instanceof DoorRefusal) || error.status !== 503 || error.code !== 'HIDE_NOT_READY') throw error;
        await notReady(error, door);
      }
    }
  };

  /**
   * @param {Door} door
   * @returns {Promise<number>}
   */
  const now = async door => (await call(door, '/v1/restore-details', { params: [] })).epoch;

  /**
   * @param {Door} door
   * @param {unknown[]} texts
   * @param {Record<string, unknown>} what
   * @param {number | null} at
   * @returns {Promise<Hid>}
   */
  const hide = async (door, texts, what, at) => {
    if (texts.length === 0) return { texts: [], spans: [] };
    const answer = await call(door, '/v1/hide-details', { ...what, texts, epoch: at ?? await now(door), ...(under.to === undefined ? {} : { to: under.to }) });
    return { texts: answer.texts, spans: answer.spans };
  };

  /**
   * @param {Tool} tool
   * @param {Record<string, unknown>} args
   * @param {Door} door
   * @returns {Promise<{ args: Record<string, unknown>, epoch: number }>}
   */
  const restore = async (tool, args, door) => {
    /** @type {{ name: string, index: number | null }[]} */
    const places = [];
    /** @type {{ value: string }[]} */
    const params = [];
    for (const [name, value] of Object.entries(args)) {
      const one = (/** @type {unknown} */ each, /** @type {number | null} */ index) => {
        if (typeof each !== 'string') return;
        places.push({ name, index });
        params.push({ value: each });
      };
      if (Array.isArray(value)) value.forEach(one);
      else one(value, null);
    }
    const answer = await call(door, '/v1/restore-details', { params });
    /** @type {{ value: string, unknown: string[] }[]} */
    const restored = answer.params;
    const unknown = restored.flatMap(each => each.unknown);
    if (unknown.length > 0 && tool.keepsUnknown !== true) throw unknownError(unknown, under);
    const copy = structuredClone(args);
    for (const [at, place] of places.entries()) {
      const value = /** @type {(typeof restored)[number]} */ (restored[at]).value;
      if (place.index === null) copy[place.name] = value;
      else /** @type {unknown[]} */ (copy[place.name])[place.index] = value;
    }
    return { args: copy, epoch: answer.epoch };
  };

  /**
   * @param {Tool} tool
   * @param {Record<string, unknown>} args
   * @param {{ door: Door, restored?: (args: Record<string, unknown>) => void }} context
   * @returns {Promise<{ answer: import('./pieces.mjs').Answer, failed: ToolError | null, epoch: number | null }>}
   */
  const answered = async (tool, args, context) => {
    const back = tool.asWritten === true ? { args, epoch: null } : await restore(tool, args, context.door);
    context.restored?.(back.args);
    try {
      return { answer: await tool.run(back.args, { ...context, written: args }), failed: null, epoch: back.epoch };
    } catch (error) {
      if (!(error instanceof ToolError) || error instanceof HidingFailed) throw error;
      return { answer: error.message, failed: error, epoch: back.epoch };
    }
  };

  /**
   * @param {Tool} tool
   * @param {Record<string, unknown>} args
   * @param {Record<string, unknown> & { door: Door }} context
   * @returns {Promise<{ run: Run, shown: string[] }>}
   */
  const routed = async (tool, args, context) => {
    const { door } = context;
    /** @type {string[]} */
    const shown = [];
    let outside = false;
    /** @type {Routed} */
    const answer = await tool.run(args, { ...context, read: async (/** @type {string} */ path, /** @type {Record<string, unknown>} */ given) => {
      const read = await route(door, path, given);
      if (read?.outside === true) outside = true;
      if (under.showed !== undefined) shown.push(...shownBy(path, read));
      return read;
    } });
    return {
      run: {
        text: noticed(JSON.stringify(answer.json), outside), images: answer.images ?? [], links: answer.links ?? [],
        ...(answer.found === undefined ? {} : { found: answer.found }), ...(answer.span === undefined ? {} : { span: answer.span }), cited: citedIn(answer.json),
      },
      shown,
    };
  };

  return {
    epoch: () => epoch,
    level: () => level,

    /**
     * @param {Door} door
     * @param {string} path
     * @param {Record<string, unknown>} args
     */
    route,

    /**
     * @param {Tool} tool
     * @param {Record<string, unknown>} args
     * @param {Record<string, unknown> & { door: Door, seen?: (url: string) => boolean, outbound?: (link: string) => Promise<void>, restored?: (args: Record<string, unknown>) => void }} context
     * @returns {Promise<Run>}
     */
    async run(tool, args, context) {
      const { run, shown } = tool.route !== undefined && tool.wrapped?.(args) !== true ? await routed(tool, args, context) : await wrappedRun(tool, args, context);
      if (under.showed !== undefined && shown.length > 0) under.showed([...new Set(shown)].join(' '));
      return run;
    },

    /**
     * @param {Door} door
     * @param {import('./pieces.mjs').Piece[][]} texts
     * @returns {Promise<string[]>}
     */
    async text(door, texts) {
      return (await hide(door, texts, { what: 'text' }, epoch)).texts.map(each => (typeof each === 'string' ? each : ''));
    },

    /**
     * @param {Door} door
     * @param {unknown[]} texts
     * @returns {Promise<Hid>}
     */
    async pictured(door, texts) {
      return hide(door, texts, { what: 'text' }, epoch);
    },

    /**
     * @param {Door} door
     * @param {string} text
     * @returns {Promise<Restored>}
     */
    async words(door, text) {
      const answer = await call(door, '/v1/restore-details', { text });
      return {
        text: answer.text, marks: answer.marks, unknown: answer.unknown,
        refs: answer.refs.map((/** @type {{ handle: string, ref: string }} */ { handle, ref }) => ({ handle, ref })),
        ...(answer.citations !== null && typeof answer.citations === 'object' ? { citations: answer.citations } : {}),
      };
    },

    /**
     * @param {Door} door
     * @param {string[]} texts
     * @returns {Promise<string[]>}
     */
    async many(door, texts) {
      if (texts.length === 0) return [];
      const answer = await call(door, '/v1/restore-details', { params: texts.map(value => ({ value })) });
      return answer.params.map((/** @type {{ value: string }} */ each) => each.value);
    },

    /** @param {Door} door */
    async learn(door) {
      return await now(door);
    },

    /** @param {unknown} error */
    erased: error => error instanceof Erased,
  };

  /**
   * @param {Tool} tool
   * @param {Record<string, unknown>} args
   * @param {{ door: Door, seen?: (url: string) => boolean, outbound?: (link: string) => Promise<void>, restored?: (args: Record<string, unknown>) => void }} context
   * @returns {Promise<{ run: Run, shown: string[] }>}
   */
  async function wrappedRun(tool, args, context) {
    const { door } = context;
    /** @type {Awaited<ReturnType<typeof answered>> | null} */
    let ran = null;
    for (let tries = 1; ; tries++) {
      try {
        const writes = typeof tool.writes === 'function' ? tool.writes(args) : tool.writes === true;
        if (ran === null || !writes) ran = await answered(tool, args, context);
        const out = tool.fixed === true ? { text: String(ran.answer), images: [], links: [], cited: [] } : await hideAnswer(ran.answer, door, { what: 'read', tool: tool.name }, ran.epoch);
        if (ran.failed !== null) throw Object.assign(new ToolError(out.text), { noted: ran.failed });
        return { run: out, shown: under.showed === undefined ? [] : wordsShown(parsed(out.text)) };
      } catch (error) {
        if (!(error instanceof Erased)) throw error;
        if (tries === TRIES) throw new HidingFailed(HIDE_FAILED);
        if (ran !== null) ran.epoch = error.epoch;
      }
    }
  }

  /**
   * @param {import('./pieces.mjs').Answer} answer
   * @param {Door} door
   * @param {Record<string, unknown>} what
   * @param {number | null} read
   * @returns {Promise<Run>}
   */
  async function hideAnswer(answer, door, what, read) {
    const lines = typeof answer === 'string' ? [answer] : answer.lines;
    /** @type {unknown[]} */
    const texts = [];
    /** @type {Map<string, number>} */
    const at = new Map();
    /** @param {unknown} text */
    const place = text => {
      const key = JSON.stringify(text);
      let index = at.get(key);
      if (index === undefined) {
        index = texts.push(text) - 1;
        at.set(key, index);
      }
      return index;
    };
    /**
     * @param {unknown} value
     * @returns {any}
     */
    const lay = value => {
      if (typeof value === 'string') return value === '' ? { as: '' } : { at: place([{ text: value }]) };
      if (value instanceof Said) return { at: place(value.pieces) };
      if (value instanceof Joined) return { parts: value.parts.map(lay) };
      if (value instanceof Hidden) return { as: value.text };
      return { as: value };
    };
    const laid = lines.map(lay);
    const out = (await hide(door, texts, what, read)).texts;
    /** @param {any} node @returns {unknown} */
    const make = node => {
      if ('at' in node) return typeof out[node.at] === 'string' ? out[node.at] : '';
      if ('parts' in node) return node.parts.map(make).join('');
      return node.as;
    };
    return { text: laid.map(make).join('\n'), images: [], links: [], cited: [] };
  }
}

/**
 * @param {unknown} json
 * @returns {Cited[]}
 */
export function citedIn(json) {
  /** @type {Cited[]} */
  const cited = [];
  /** @param {unknown} value */
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== 'object') return;
    const object = /** @type {Record<string, unknown>} */ (value);
    if (typeof object.ref === 'string' && HANDLE.test(object.ref)) {
      cited.push({ handle: object.ref, ...(typeof object.title === 'string' && object.title !== '' ? { title: object.title } : {}) });
    }
    Object.values(object).forEach(walk);
  };
  walk(json);
  return cited;
}

/**
 * @param {string[]} unknown
 * @param {Under} under
 */
function unknownError(unknown, under) {
  const who = under.agent ? 'you were given' : 'this conversation gave';
  return new HidingFailed(`${[...new Set(unknown)].join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a placeholder or a handle ${who}: pass each exactly as an answer gave it.`, { unknown });
}


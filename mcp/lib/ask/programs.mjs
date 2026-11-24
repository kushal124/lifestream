// @ts-check
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * @typedef {'chatgpt' | 'claude'} Subscription
 * @typedef {'codex' | 'claude'} Program
 * @typedef {{ chosen: boolean, binary: string | null, home: string }} Held
 * @typedef {{ binary: string, home: string }} At
 */

const FAILED_MS = 60_000;

export const PROGRAM_OF = /** @type {const} */ ({ chatgpt: 'codex', claude: 'claude' });

export const PRODUCT = /** @type {const} */ ({ chatgpt: 'Codex', claude: 'Claude Code' });

/**
 * @param {string} machine
 * @param {Program} name
 * @returns {Held}
 */
export function programOf(machine, name) {
  const folder = join(machine, 'subscriptions', name);
  const home = join(machine, name);
  let chosen = false;
  try {
    chosen = statSync(folder).isDirectory();
  } catch {
    return { chosen, binary: null, home };
  }
  let named;
  try {
    named = readFileSync(join(folder, 'current'), 'utf8').trim();
  } catch {
    return { chosen, binary: null, home };
  }
  const parts = named.split('/');
  if (named === '' || named.startsWith('/') || parts.includes('..') || parts.includes('.') || parts.length < 2) return { chosen, binary: null, home };
  const binary = join(folder, ...parts);
  try {
    if (!lstatSync(binary).isFile() || realpathSync(binary) !== join(realpathSync(folder), ...parts)) return { chosen, binary: null, home };
    accessSync(binary, constants.X_OK);
  } catch {
    return { chosen, binary: null, home };
  }
  return { chosen, binary, home };
}

/**
 * @param {string} machine
 * @param {Program} name
 * @returns {At | null}
 */
export function programAt(machine, name) {
  const { binary, home } = programOf(machine, name);
  return binary === null ? null : { binary, home };
}

/** @param {NodeJS.ProcessEnv} [env] */
export function machineDir(env = process.env) {
  const named = env.LIFESTREAM_MACHINE_DIR;
  if (named !== undefined && named !== '') {
    if (!isAbsolute(named)) throw new Error(`LIFESTREAM_MACHINE_DIR is ${named}: name an absolute path`);
    return named;
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Lifestream');
  const data = env.XDG_DATA_HOME;
  return join(data !== undefined && isAbsolute(data) ? data : join(homedir(), '.local', 'share'), 'lifestream');
}

/**
 * @template T
 * @param {number} ms
 * @param {() => Promise<T>} ask
 * @param {() => number} now
 */
export function kept(ms, ask, now) {
  /** @type {{ until: number, answer: Promise<T> } | null} */
  let held = null;
  return {
    /** @returns {Promise<T>} */
    read() {
      if (held !== null && now() < held.until) return held.answer;
      const answer = ask();
      const these = { until: now() + ms, answer };
      held = these;
      answer.catch(() => { these.until = now() + FAILED_MS; });
      return answer;
    },
    forget() {
      held = null;
    },
  };
}

/** @param {Subscription} of */
export const downloading = of => `${PRODUCT[of]} is downloading. Ask again in a minute.`;

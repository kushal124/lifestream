// @ts-check
import { extractText } from 'unpdf';
import { ToolError, argumentError } from '../../errors.mjs';
import { guardedOpen, Unopened } from '../../guarded.mjs';
import { Hidden, joined } from '../../pieces.mjs';
import { cut, MAX_CHARS, NOTE } from '../../shape.mjs';


/** @typedef {import('../../tools.mjs').Context} Context */

const WAIT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 5;
const PART = MAX_CHARS - 1_000;

export const LINK_WORDS = '`link`: a link the person wrote or a record holds, word for word, opened.';

/** @param {{ link?: unknown }} args */
export const opensLink = args => typeof args.link === 'string';

/**
 * @param {{ link?: string, cursor?: string }} args
 * @param {Context} context
 * @returns {Promise<import('../../pieces.mjs').Answer>}
 */
export async function openLink({ link: url, cursor }, { seen, written, outbound }) {
  if (typeof url !== 'string') throw argumentError('link is the link to open, exactly as the record or the person wrote it');
  const at = cursor === undefined ? 0 : /^\d+$/u.test(cursor) ? Number(cursor) : null;
  if (at === null) throw argumentError('A link\'s `cursor` is the number its last part named: pass it with the same `link`.');
  const asWritten = typeof written?.link === 'string' ? written.link : url;
  if (seen === undefined || !seen(asWritten)) {
    throw new ToolError('That link is in neither the person\'s words nor a record a tool showed: read opens only a link the person or the record gave, word for word, never one an opened page holds.');
  }
  await outbound?.(url);
  const read = await opened(exported(url));
  const text = read.text.slice(at, at + PART);
  const more = at + PART < read.text.length;
  return { lines: [
    NOTE,
    joined('Opened ', new Hidden(asWritten), read.url === url ? '' : joined(' (read at ', read.url, ')'),
      `: ${read.type}`, ...(read.title ? [', “', cut(read.title, 300), '”'] : []),
      `${read.text.length > PART ? `, characters ${at + 1} to ${at + text.length} of ${read.text.length}` : ''}.`),
    '',
    text,
    '',
    more ? `next: the same \`link\` with \`cursor: "${at + PART}"\`` : 'That is the end of the text.',
  ] };
}

/** @param {string} url */
function exported(url) {
  const drive = /^https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]+)/u.exec(url);
  if (drive !== null) return `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  const docs = /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/u.exec(url);
  if (docs === null) return url;
  const [, kind, id] = docs;
  return `https://docs.google.com/${kind}/d/${id}/${kind === 'spreadsheets' ? 'export?format=csv' : kind === 'presentation' ? 'export/txt' : 'export?format=txt'}`;
}

/**
 * @param {string} first
 * @returns {Promise<{ url: string, type: string, title: string | null, text: string }>}
 */
async function opened(first) {
  /** @type {Awaited<ReturnType<typeof guardedOpen>>} */
  let answer;
  try {
    answer = await guardedOpen(first, {
      hops: MAX_HOPS, waitMs: WAIT_MS, maxBytes: MAX_BYTES,
      headers: { 'user-agent': 'Lifestream-Ask/1 (read-only)', accept: 'text/html, text/plain, application/pdf, */*;q=0.5' },
      hop: url => {
        if (SIGN_IN.test(url.href)) throw new Unopened(`The link needs a sign-in (it redirected to ${url.host}): only a public page or file can be read.`);
      },
    });
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : String(error));
  }
  const { url, status, headers, body } = answer;
  if (status === 401 || status === 403) throw new ToolError(`The link needs a sign-in (${url.host} answered ${status}): only a public page or file can be read.`);
  if (status !== 200) throw new ToolError(`${url.host} answered ${status}.`);
  return { url: url.href, ...await readOut(body, String(headers['content-type'] ?? '')) };
}

const SIGN_IN = /^https:\/\/(?:accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com)\/|\/(?:sign[-_]?in|log[-_]?in|ServiceLogin)\/?(?:[?#]|$)/iu;

/**
 * @param {Buffer} body
 * @param {string} type
 * @returns {Promise<{ type: string, title: string | null, text: string }>}
 */
async function readOut(body, type) {
  const media = type.split(';')[0]?.trim().toLowerCase() || 'unknown';
  if (media === 'application/pdf' || body.subarray(0, 5).toString('latin1') === '%PDF-') {
    const { text, totalPages } = await extractText(new Uint8Array(body), { mergePages: true });
    return { type: `a PDF of ${totalPages} pages`, title: null, text: text.trim() };
  }
  const words = body.toString('utf8');
  if (media === 'text/html' || media === 'application/xhtml+xml' || /^\s*<(?:!doctype html|html)/iu.test(words)) {
    return { type: 'a page', title: decoded(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(words)?.[1] ?? '').trim() || null, text: mainText(words) };
  }
  if (media.startsWith('text/') || media === 'application/json' || media === 'application/xml') return { type: media, title: null, text: words };
  throw new ToolError(`The link is a ${media} file of ${body.length} bytes: read opens pages, PDFs and text.`);
}

/** @param {string} html */
function mainText(html) {
  const bare = html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<(script|style|noscript|svg|template|head|nav|footer|form|iframe)\b[\s\S]*?<\/\1\s*>/giu, '');
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(bare)?.[2] ?? /<body\b[^>]*>([\s\S]*)<\/body>/iu.exec(bare)?.[1] ?? bare;
  return decoded(main.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)\b[^>]*>/giu, '\n').replace(/<[^>]+>/gu, ' '))
    .split('\n').map(line => line.replace(/\s+/gu, ' ').trim()).filter(line => line !== '').join('\n');
}

/** @param {string} text */
function decoded(text) {
  /** @type {Record<string, string>} */
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[name.toLowerCase()] ?? whole;
  });
}

// @ts-check
import { Marked } from '../marked.js';
import DOMPurify from '../purify.js';
import { esc } from '../lib/html.js';

const ANSWER_TAGS = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

const replyMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text, block }) => block ? `<p>${esc(text.trim())}</p>\n` : esc(text),
    link({ href, tokens }) {
      const words = this.parser.parseInline(tokens);
      return /^https?:\/\//u.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${words}</a>` : words;
    },
    image: ({ text }) => esc(text),
  },
});

/** @param {string} text */
export function replyMarkdown(text) {
  const html = /** @type {string} */ (replyMarked.parse(text));
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: [...ANSWER_TAGS, 'a'], ALLOWED_ATTR: ['start', 'href', 'target', 'rel'] });
}

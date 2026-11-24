// @ts-check


export class ToolError extends Error {}

const NOT_YET = 'The home could not answer this yet';

/** @param {string | undefined} line */
export const notYet = line => line?.startsWith(`${NOT_YET}:`) === true;

/**
 * @param {string} code
 * @param {string} said
 * @param {number | null} retryAfter
 * @param {Record<string, unknown>} body
 * @returns {string | null}
 */
function plainLine(code, said, retryAfter, body) {
  const again = retryAfter === null ? 'Ask again in a moment' : `Ask again in ${retryAfter} s`;
  switch (code) {
    case 'INDEX_BUILDING': return `${NOT_YET}: it is still building what it reads (${unstop(said)}). ${again}; this says nothing of what the record holds.`;
    case 'NOT_NOW': return `${NOT_YET}: ${unstop(said)}. ${again}; this says nothing of what the record holds.`;
    case 'LOCKED': return sentence(said);
    case 'TOO_BROAD': return tooBroad(said, body.fits);
    case 'CURSOR_EXPIRED': return `That cursor or handle no longer holds: ${unstop(said)}, without it.`;
    case 'LINE_MOVED': return `That day line moved since its handle was given (${unstop(said)}): read the day again, or search for the line.`;
    case 'BAD_PARAMETER': return `An argument is not one this takes: ${unstop(said)}. Fix it and ask again.`;
    case 'PERSON_UNKNOWN': return personUnknown(said, body.matches);
    case 'OUTSIDE_ACCESS': return sentence(said);
    case 'HANDLE_UNKNOWN': return `That handle was not given here (${unstop(said)}): pass a handle exactly as an answer gave it.`;
    default: return null;
  }
}

/**
 * @param {string} said
 * @param {unknown} matches
 * @returns {string}
 */
function personUnknown(said, matches) {
  const several = Array.isArray(matches) ? matches.filter(each => typeof each?.ref === 'string' && typeof each?.name === 'string') : [];
  if (several.length === 0) return sentence(said);
  return `${sentence(said)} They are: ${several.map(each => `${each.ref} ${each.name}`).join('; ')}. Pass the one meant as \`person\`, by its handle.`;
}

/**
 * @param {string} said
 * @param {unknown} fits
 */
function tooBroad(said, fits) {
  const range = /** @type {{ from?: unknown, to?: unknown } | null} */ (typeof fits === 'object' ? fits : null);
  if (typeof range?.from === 'string' && typeof range.to === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(range.from)) {
    const before = new Date(Date.parse(`${range.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return `Too much to count in one call. ${range.from} → ${range.to} fits: ask it, then the rest with \`to: ${before}\`.`;
  }
  return `Too much to count in one call, and not one whole day of it fits, so no range would: ${unstop(said)}.`;
}

/** @param {string} said */
const sentence = said => (/[.!?]$/u.test(said) ? said : `${said}.`);
/** @param {string} said */
const unstop = said => said.replace(/[.\s]+$/u, '');

/** @param {string} message */
export function argumentError(message) {
  return new ToolError(message);
}

export class DoorRefusal extends ToolError {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} said
   * @param {number | null} retryAfter
   * @param {Record<string, unknown>} body
   */
  constructor(status, code, said, retryAfter, body = {}) {
    const retry = retryAfter === null || code === 'OUTCOME_UNKNOWN' ? '' : ` Retry after ${retryAfter} s.`;
    const why = status === 401 ? ' The pass this agent sent is not one the door knows (revoked, suspended or mistyped).' : '';
    const line = plainLine(code, said, retryAfter, body);
    super(line === null ? `The door refused: ${status} ${code}: ${sentence(said)}${why}${retry}` : line);
    this.status = status;
    this.code = code;
    this.said = said;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

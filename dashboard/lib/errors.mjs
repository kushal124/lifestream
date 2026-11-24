// @ts-check

/** @typedef {Error & { status: number }} StatusError */

/**
 * @param {string} message
 * @param {number} status
 * @returns {StatusError}
 */
export function statusError(message, status) {
  return Object.assign(new Error(message), { status });
}

const PATH = /(?:\/[^\s/:;,'"()]+){2,}\/?/gu;

/** @param {string} text */
export const withoutPaths = text => text.replace(PATH, '…');

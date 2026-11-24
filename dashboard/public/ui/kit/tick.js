// @ts-check

/**
 * @param {boolean} on
 * @param {{ photo?: boolean }} [options]
 */
export const tick = (on, { photo = false } = {}) => `<span class="ck-tick${photo ? ' ck-tick--photo' : ''}${on
  ? ' is-on' : ''}" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="M6.2 10.4 8.9 13 13.8 7.4"/></svg></span>`;

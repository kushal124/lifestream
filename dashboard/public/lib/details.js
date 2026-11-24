// @ts-check

/** @typedef {'instagram' | 'x' | 'linkedin' | 'facebook' | 'github' | 'site'} Network */
/** @typedef {{ network: Network, value: string }} Profile */
/** @typedef {{ month: number, day: number, year: number | null }} Birthday */
/** @typedef {{ work: string | null, birthday: Birthday | null, profiles: Profile[] }} Details */

export const NETWORKS = /** @type {const} */ ({
  instagram: 'Instagram', x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook', github: 'GitHub', site: 'Site',
});
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const SOON_DAYS = 14;

/**
 * @param {number} month
 * @param {number | null} year
 */
export const daysIn = (month, year) => new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate();

/**
 * @param {Profile} left
 * @param {Profile} right
 */
export const sameProfile = (left, right) => left.network === right.network && left.value === right.value;

/** @param {Profile} profile */
export function profileHref({ network, value }) {
  const handle = encodeURIComponent(value);
  if (network === 'instagram') return `https://www.instagram.com/${handle}/`;
  if (network === 'x') return `https://x.com/${handle}`;
  if (network === 'linkedin') return `https://www.linkedin.com/in/${handle}/`;
  if (network === 'facebook') return `https://www.facebook.com/${handle}`;
  if (network === 'github') return `https://github.com/${handle}`;
  return `https://${value}`;
}

/**
 * @param {Profile} profile
 * @param {{ path?: boolean }} [options]
 */
export function profileWords({ network, value }, { path = false } = {}) {
  if (network === 'site') return path ? value : value.split('/')[0];
  return network === 'instagram' || network === 'x' ? `@${value}` : value;
}

/** @param {Network} network */
export const profileGlyph = network => network === 'site' ? 'web' : network;

/**
 * @param {Birthday} birthday
 * @param {{ short?: boolean }} [options]
 */
export function birthdayWords({ month, day, year }, { short = false } = {}) {
  const name = MONTHS[month - 1] ?? '';
  return short ? `${day} ${name.slice(0, 3)}` : `${day} ${name}${year === null ? '' : ` ${year}`}`;
}

/**
 * @param {Birthday} birthday
 * @param {string} today
 */
export function birthdayChip(birthday, today) {
  const [year, month, date] = today.split('-').map(Number);
  const now = Date.UTC(year, month - 1, date);
  const on = (/** @type {number} */ y) => Date.UTC(y, birthday.month - 1, Math.min(birthday.day, daysIn(birthday.month, y)));
  const next = on(year) >= now ? on(year) : on(year + 1);
  const days = Math.round((next - now) / 86_400_000);
  if (days === 0) return 'Birthday today';
  if (days <= SOON_DAYS) return `Birthday in ${days} ${days === 1 ? 'day' : 'days'}`;
  return birthdayWords(birthday, { short: true });
}

/**
 * @param {string} value
 * @returns {Birthday | null}
 */
export function birthdayOf(value) {
  const found = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/u.exec(value);
  if (!found) return null;
  const year = found[1] === undefined ? null : Number(found[1]);
  const month = Number(found[2]);
  const day = Number(found[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(month, year) ? { month, day, year } : null;
}

/**
 * @param {string} value
 * @returns {Profile | null}
 */
export function suggestedProfile(value) {
  const colon = value.indexOf(':');
  const network = value.slice(0, colon);
  return colon < 0 || !(network in NETWORKS) ? null : { network: /** @type {Network} */ (network), value: value.slice(colon + 1) };
}

/** @returns {Details} */
export const noDetails = () => ({ work: null, birthday: null, profiles: [] });

/**
 * @param {Details} now
 * @param {Details} before
 * @returns {Partial<Details>}
 */
export function changedDetails(now, before) {
  const day = (/** @type {Birthday | null} */ b) => (b === null ? '' : `${b.year ?? ''}-${b.month}-${b.day}`);
  /** @type {Partial<Details>} */
  const changed = {};
  if ((now.work ?? null) !== (before.work ?? null)) changed.work = now.work ?? null;
  if (day(now.birthday) !== day(before.birthday)) changed.birthday = now.birthday;
  if (now.profiles.length !== before.profiles.length || !now.profiles.every((each, at) => sameProfile(each, before.profiles[at]))) {
    changed.profiles = now.profiles;
  }
  return changed;
}

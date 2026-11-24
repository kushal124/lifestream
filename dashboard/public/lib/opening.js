// @ts-check
/**
 * @typedef {{ page: 'days', day: string, focus?: string | null } | { page: 'month', month: string, day: string | null }
 *   | { page: 'people', id: string, person?: string | null, group?: string | null } | { page: 'places', id: string } | { page: 'read' }} Opens
 * @typedef {{ ref: string, kind?: string, opens?: Opens }} Described
 */

/**
 * @param {Opens | null | undefined} opens
 * @returns {{ on: string, focus: string } | null}
 */
export function momentAt(opens) {
  if (opens?.page !== 'days') return null;
  return { on: opens.day, focus: opens.focus ?? '' };
}

/**
 * @param {Opens | null | undefined} opens
 * @returns {{ go: string, patch: Record<string, string> } | null}
 */
export function routeOf(opens) {
  if (!opens) return null;
  switch (opens.page) {
    case 'days': {
      const { on, focus } = /** @type {{ on: string, focus: string }} */ (momentAt(opens));
      return { go: 'days', patch: focus ? { on, focus } : { on } };
    }
    case 'month':
      return opens.day ? { go: 'days', patch: { on: opens.day } } : null;
    case 'people':
      return { go: 'people', patch: { focus: opens.person ?? (opens.group ? `chat:${opens.group}` : opens.id) } };
    case 'places':
      return { go: 'places', patch: { focus: opens.id } };
    case 'read':
      return null;
  }
}

/**
 * @param {Described | undefined} described
 * @returns {{ panel: true } | { go: string, patch: Record<string, string> } | null}
 */
export function openingOf(described) {
  const opens = described?.opens;
  if (!described || !opens) return null;
  if (described.kind === 'row' || momentAt(opens)?.focus) return { panel: true };
  return routeOf(opens);
}

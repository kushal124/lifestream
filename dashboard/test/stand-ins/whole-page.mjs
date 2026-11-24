// @ts-check
import { pageOf } from '../../public/ui/connectors/page.js';

/** @typedef {import('../../public/ui/connectors/page.js').Page} Page */

/**
 * @param {Parameters<typeof pageOf>[0]} report
 * @param {Parameters<typeof pageOf>[1]} state
 * @param {Parameters<typeof pageOf>[2]} filter
 * @param {Parameters<typeof pageOf>[3]} [read]
 * @returns {Page}
 */
export function wholePage(report, state, filter, read) {
  const connected = pageOf(report, state, { ...filter, shown: 'connected' }, read);
  const not = pageOf(report, state, { ...filter, shown: 'not' }, read);
  const count = connected.count + not.count;
  return { ...not, sections: [...connected.sections, ...not.sections], count, empty: report && count === 0 ? not.empty : '',
    placeCounts: /** @type {Page['placeCounts']} */ (Object.fromEntries(Object.entries(not.placeCounts)
      .map(([key, kept]) => [key, kept + connected.placeCounts[/** @type {keyof Page['placeCounts']} */ (key)]]))) };
}

/**
 * @param {import('../../public/types.js').StreamsReport} report
 * @param {import('../../public/types.js').ConnectorReport} connector
 */
export const standsInImport = (report, connector) => !connector.set_up && connector.roads.every(road => road === 'upload')
  && report.imports.some(kind => kind.products.length === 0 && kind.kind === connector.export?.import);

/**
 * @param {Parameters<typeof pageOf>[0]} report
 * @param {Parameters<typeof pageOf>[1]} state
 * @param {Parameters<typeof pageOf>[2]} filter
 */
export const importsLastInEachView = (report, state, filter) => /** @type {const} */ (['connected', 'not']).every(shown => {
  const keys = pageOf(report, state, { ...filter, shown }).sections.map(section => section.key);
  return !keys.includes('imports') || keys.at(-1) === 'imports';
});

// @ts-check

/**
 * @param {Element} element
 * @param {string} name
 */
export function duration(element, name) {
  const time = getComputedStyle(element).getPropertyValue(name).trim();
  return (parseFloat(time) || 0) * (time.endsWith('ms') ? 1 : 1000);
}

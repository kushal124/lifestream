// @ts-check

/** @param {string} month */
export function monthGrid(month) {
  const [year, number] = month.split('-').map(Number);
  return {
    offset: (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7,
    count: new Date(Date.UTC(year, number, 0)).getUTCDate(),
  };
}

/** @param {number} year */
const leap = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * @param {number} month
 * @param {number | null} year
 * @param {number} thisYear
 */
export function birthdayMonth(month, year, thisYear) {
  let drawn = year ?? thisYear;
  if (year === null && month === 2) while (!leap(drawn)) drawn += 1;
  const before = new Date(Date.UTC(drawn, month - 1, 0)).getUTCDate();
  return { year: drawn, ...monthGrid(`${drawn}-${String(month).padStart(2, '0')}`), before };
}

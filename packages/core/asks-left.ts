import type { Sql } from "./sql.js";

const DAY_MS = 86_400_000;
export const LEFT_MARK = "asks:left";
export const FILL_ASKS = 4096;
const KEY = "work_id, started, at_key, unit, item, prompt, family";
const KEY_PARAMS = "(?, ?, ?, ?, ?, ?, ?)";
const PICK = "asks INDEXED BY asks_pick";

export interface LeftMark {
  at: unknown[] | null;
}

export function leftMark(sql: Sql): LeftMark | null {
  const value = sql.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", LEFT_MARK)?.value;
  return value === undefined ? null : JSON.parse(value) as LeftMark;
}

function dayOf(ms: string): string {
  return `(CASE WHEN ${ms} >= 0 THEN ${ms} / ${DAY_MS} ELSE (${ms} + 1) / ${DAY_MS} - 1 END)`;
}

function add(sql: Sql, from: string, sign: 1 | -1, where: string, ...params: unknown[]): void {
  sql.run(
    `INSERT INTO asks_left (work_id, prompt, day, pending)
     SELECT work_id, prompt, day, ${sign} * pending FROM (SELECT work_id, prompt, ${dayOf("at_key")} AS day, count(*) AS pending FROM ${from}
       WHERE ${where} AND state = 'pending' AND work_id IS NOT NULL GROUP BY work_id, prompt, day) WHERE true
     ON CONFLICT (work_id, prompt, day) DO UPDATE SET pending = pending + excluded.pending`,
    ...params,
  );
}

export function countAsks(sql: Sql, sign: 1 | -1, from: string, where: string, ...params: unknown[]): void {
  const mark = leftMark(sql);
  if (mark === null) add(sql, from, sign, where, ...params);
  else if (mark.at !== null) add(sql, from, sign, `(${where}) AND (${KEY}) <= ${KEY_PARAMS}`, ...params, ...mark.at);
}

export function fillLeft(sql: Sql): boolean {
  sql.writing();
  const mark = leftMark(sql);
  if (mark === null) return true;
  const after = mark.at === null ? "work_id IS NOT NULL" : `(${KEY}) > ${KEY_PARAMS}`;
  const passed = mark.at ?? [];
  const last = sql.get<Record<string, unknown>>(
    `SELECT ${KEY} FROM ${PICK} WHERE state = 'pending' AND ${after} ORDER BY ${KEY} LIMIT 1 OFFSET ${FILL_ASKS - 1}`, ...passed,
  );
  if (last === undefined) {
    add(sql, PICK, 1, after, ...passed);
    sql.run("DELETE FROM meta WHERE key = ?", LEFT_MARK);
    return true;
  }
  const through = Object.values(last);
  add(sql, PICK, 1, `${after} AND (${KEY}) <= ${KEY_PARAMS}`, ...passed, ...through);
  sql.run("UPDATE meta SET value = ? WHERE key = ?", JSON.stringify({ at: through } satisfies LeftMark), LEFT_MARK);
  return false;
}

export function leftOf(sql: Sql, work_id: string, starts: readonly number[]): { prompt: string; total: number; from: number[] }[] | null {
  if (leftMark(sql) !== null) return null;
  const distinct = [...new Set(starts)];
  const start = "CAST(? AS INTEGER)";
  const whole = `${dayOf(start)} + (${start} % ${DAY_MS} <> 0)`;
  const rows = sql.all<{ prompt: string; total: number } & Record<string, number>>(
    `SELECT prompt, sum(pending) AS total${distinct.map((_, index) => `, sum(CASE WHEN day >= ${whole} THEN pending ELSE 0 END) AS s${index}`).join("")}
     FROM asks_left WHERE work_id = ? GROUP BY prompt HAVING total > 0 ORDER BY prompt`,
    ...distinct.flatMap((each) => [each, each, each, each]), work_id,
  );
  const counts = new Map(rows.map((row) => [row.prompt, distinct.map((_, index) => row[`s${index}`]!)]));
  distinct.forEach((each, index) => {
    if (each % DAY_MS === 0) return;
    const day = sql.all<{ prompt: string; n: number }>(
      `SELECT prompt, count(*) AS n FROM asks INDEXED BY asks_pick
       WHERE work_id = ? AND state = 'pending' AND started IN (0, 1) AND at_key >= ${start} AND at_key < (${dayOf(start)} + 1) * ${DAY_MS}
       GROUP BY prompt`,
      work_id, each, each, each, each,
    );
    for (const { prompt, n } of day) counts.get(prompt)![index]! += n;
  });
  return rows.map((row) => ({ prompt: row.prompt, total: row.total, from: starts.map((each) => counts.get(row.prompt)![distinct.indexOf(each)]!) }));
}

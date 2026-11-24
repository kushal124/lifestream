// @ts-check
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** @param {string} name */
const kept = name => JSON.parse(readFileSync(new URL(`../../packages/home/contract/${name}`, import.meta.url), 'utf8'));

const PARAMS = /** @type {Record<string, { properties: Record<string, object> }>} */ (kept('params.json'));

/**
 * @param {{ properties: Record<string, object> }} schema
 * @returns {Record<string, z.ZodType>}
 */
export function shapeOf(schema) {
  return Object.fromEntries(Object.entries(schema.properties).map(([name, member]) => {
    const { maximum: _most, ...taken } = /** @type {{ maximum?: number }} */ (member);
    return [name, z.fromJSONSchema(/** @type {any} */ (taken)).optional()];
  }));
}

/**
 * @template {Record<string, unknown>} T
 * @param {string} route
 * @param {T} args
 * @returns {{ args: T, lines: string[][] }}
 */
export function atMost(route, args) {
  const properties = /** @type {Record<string, { maximum?: number }>} */ (PARAMS[route]?.properties ?? {});
  /** @type {string[][]} */
  const lines = [];
  const given = { ...args };
  for (const [name, { maximum }] of Object.entries(properties)) {
    const value = given[name];
    if (maximum === undefined || typeof value !== 'number' || value <= maximum) continue;
    /** @type {Record<string, unknown>} */ (given)[name] = maximum;
    lines.push([`\`${name}\` is ${maximum} at most: ${maximum} given`]);
  }
  return { args: given, lines };
}

/** @param {string} route */
export function inputSchemaOf(route) {
  const schema = PARAMS[route];
  if (schema === undefined) throw new Error(`the contract's parameters file names no route ${route}`);
  return shapeOf(schema);
}

/**
 * @template {{ cursor?: unknown, limit?: unknown }} T
 * @param {T} args
 * @returns {Record<string, unknown>}
 */
export function continued(args) {
  return { cursor: args.cursor, ...(args.limit === undefined ? {} : { limit: args.limit }) };
}

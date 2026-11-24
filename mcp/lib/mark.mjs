// @ts-check
import { readFileSync } from 'node:fs';

export const MARK = readFileSync(new URL('../../design/marks/logo-macos-dark.svg', import.meta.url), 'utf8').trim();

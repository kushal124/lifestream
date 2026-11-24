// @ts-check
import { personFace } from './person-face.js';

const MOST = 3;

/** @param {{ name: string, photo?: string }[]} people */
export function faceStack(people) {
  if (!people.length) return '';
  const drawn = people.length > MOST ? people.slice(0, MOST - 1) : people;
  const more = people.length - drawn.length;
  return '<span class="ck-fstack" aria-hidden="true">'
    + drawn.map(({ name, photo = '' }) => personFace({ name, photo, size: 'sm' })).join('')
    + (more ? `<span class="ck-mono ck-mono--sm ck-fstack__more">+${more}</span>` : '') + '</span>';
}

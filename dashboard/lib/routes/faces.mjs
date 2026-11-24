// @ts-check
/** @import { Route } from './router.mjs' */
/** @import { FacesReader } from '../faces.mjs' */
import { reply } from './router.mjs';

/**
 * @param {FacesReader} faces
 * @returns {Route[]}
 */
export function facesRoutes(faces) {
  return [
    { method: 'GET', path: '/api/faces', handle: async () => reply(await faces.deck()) },
    { method: 'GET', path: '/api/faces/group', handle: async ({ url }) => reply(await faces.card(url.searchParams.get('id') ?? '')) },
    {
      method: 'GET', path: '/api/faces/likely',
      handle: async ({ url }) => reply(await faces.likely(url.searchParams.get('id') ?? '')),
    },
  ];
}

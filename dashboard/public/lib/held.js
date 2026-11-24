// @ts-check
/** @import { HomeChange } from '../ui/live.js' */
import { fetchLifePlaces, fetchLifeProducts, fetchPeople } from './api.js';
import { holdProducts } from './kinds.js';
import { changedPast, onHomeChange } from '../ui/live.js';

/**
 * @template T
 * @param {(asked?: import('./api.js').Settled) => Promise<T>} read
 */
function held(read) {
  /** @type {Promise<T> | null} */
  let kept = null;
  /** @type {T | null} */
  let landed = null;
  let begun = 0;
  /** @type {Set<(answer: T | null) => void>} */
  const followers = new Set();
  /** @param {T | null} answer */
  const tell = answer => {
    for (const follower of followers) follower(answer);
  };
  const start = () => {
    const mine = ++begun;
    const asked = read();
    kept = asked;
    asked.then(answer => {
      if (mine !== begun) return;
      landed = answer;
      tell(answer);
    }, () => {
      if (mine === begun) kept = null;
    });
    return asked;
  };
  return {
    get: () => kept ?? start(),
    fresh: start,
    /** @param {AbortSignal} signal */
    settled(signal) {
      const at = begun;
      const asked = read({ settled: true, signal });
      asked.then(answer => {
        if (at !== begun) return;
        begun += 1;
        kept = asked;
        landed = answer;
        tell(answer);
      }, () => undefined);
      return asked;
    },
    now: () => landed,
    forget() {
      begun += 1;
      kept = null;
      landed = null;
      tell(null);
    },
    /**
     * @param {(answer: T | null) => void} follower
     * @returns {() => void}
     */
    follow(follower) {
      followers.add(follower);
      return () => followers.delete(follower);
    },
  };
}

export const heldPeople = held(fetchPeople);

/**
 * @template {{ id: string }} P
 * @param {{ people: P[], you?: P | null }} list
 * @returns {P[]}
 */
export const everyone = list => list.you ? [...list.people, list.you] : list.people;
export const heldPlaces = held(fetchLifePlaces);
export const heldProducts = held(() => fetchLifeProducts().then(answer => {
  holdProducts(answer.products);
  return answer;
}));

/**
 * @param {HomeChange} change
 * @returns {boolean}
 */
export const placesMoved = change => change.reset || change.places
  || [...change.imports].some(source => source.startsWith('places:') || source.startsWith('devices:'));

/** @returns {() => void} */
export function installHeld() {
  void heldProducts.get().catch(() => undefined);
  return onHomeChange((/** @type {HomeChange} */ change) => {
    if (change.reset) {
      heldPeople.forget();
      heldPlaces.forget();
      heldProducts.forget();
      void heldProducts.get().catch(() => undefined);
      return;
    }
    const told = [...change.imports].some(source => source.startsWith('people:'));
    const said = /** @type {{ position?: string | null } | null} */ (heldPeople.now())?.position;
    if (told || (change.people && changedPast(change.peopleChanged, said))) heldPeople.forget();
    if (placesMoved(change)) heldPlaces.forget();
  });
}

// @ts-check
/** @import { PageContext } from '../route.js' */
/** @import { PlaceAction, PlacePhoto, Suggested, Suggestion, Editing } from '../../lib/places.js' */
/** @import { Named, Sitting } from '../../lib/place-naming.js' */
/** @import { Circle, CircleWorld } from '../../lib/circle.js' */
/** @import { Camera, CameraWord, Summary } from '../../lib/where.js' */
/** @import { Removal } from './cameras.js' */
/** @import { MapMark, MapView } from '../kit/map.js' */
/** @import { EditNote } from './place.js' */
/** @import { City } from './list.js' */
/** @import { PhotoPages } from '../../lib/photo-pages.js' */
/** @import { World } from './atlas.js' */
/** @import { Place, PlaceEdit, PlaceRow, PlaceVisit, Places, SpotRow, Year } from '../../pages.js' */
import {
  actUntilAnswered, fetchAtlas, fetchConnectors, fetchDevices, fetchPage, fetchPlacePhotos, fetchSuggestions, fetchWhere,
} from '../../lib/api.js';
import { restOn } from '../../lib/ahead.js';
import { pageMoved, readMoves } from '../../lib/pages.js';
import { readHost } from '../../lib/host.js';
import { actSaid, actWords, pageReach, requestState, wordsOr } from '../../lib/reach.js';
import { SPOT_RADIUS_M, circlesOf, placeEdit, stated } from '../../lib/places.js';
import {
  HOME_NAME, TYPED_REST_MS, askedWords, canSave, fieldName, finishWords, fromGoogle, keyCommand, litFor, moved, rowsOf,
  startSitting,
} from '../../lib/place-naming.js';
import { CIRCLES_MAX, besideCircle, changedAt, draggedStays, notch, takesInWords } from '../../lib/circle.js';
import { photoPages } from '../../lib/photo-pages.js';
import { dayAt, today } from '../../lib/home-clock.js';
import { whenWords } from '../../lib/words.js';
import { cameraAction } from '../../lib/where.js';
import {
  ARRIVES, fitted, installCardGrid, installChoiceRows, installMaps, listRows, mapFrame, nameCredit,
  noneLine, openPhotoPages, openPhotoViewer, pageLack, reading, readingAgain, searchWaiting, sectionLabel, showLine,
  showReach, waitLine, watchPictures,
} from '../kit/index.js';
import { applyGeometry } from '../geometry.js';
import { put } from '../flows/frame.js';
import { atOrPast, onHomeChange } from '../live.js';
import { settledReads } from '../settled.js';
import { installMomentPanel } from '../panel.js';
import {
  cardFoot, cardTop, cityGroups, cityRows, citySince, credit, foundIn, inviteCard, listBar, listViews, nowhereYet, pageBar,
  placeRow, placeRows, rowsReading,
} from './list.js';
import {
  finishBody, finishFoot, hiddenPage, hiddenTop, namePlaceholder, nameRows, namingBody, namingFoot, namingReading, namingTop,
} from './naming.js';
import { askLine, editBody, editFoot, editNote, editTop, placeBody, placeBodyReading, placeTop } from './place.js';
import { visitWords } from './rows.js';
import { tripOf, tripPage, tripPageReading, tripsBody, tripsReading, yearStepper } from './trips.js';
import { camerasDialog, removalWord, removePage, sampleTile } from './cameras.js';

const AROUND_CITY_M = 400;
const CITIES_PAD_PX = 80;
const CITY_ALONE_M = 20000;
const AROUND_ONE_M = 300;
const AROUND_PLACE_M = 600;
const EDIT_ROOM_M = 60;
const AROUND_HIDDEN_M = 160;
const CITY = 'city:';
const UNNAMED = 'Unnamed spot';

/** @typedef {{ value?: unknown, error?: string, at: number, pending?: boolean }} Kept */

/** @typedef {{ key: string, kind: 'place' | 'spot', name: string, latitude: number, longitude: number, radius: number, also: Circle[] }} Held */

const TO_LIST = { label: 'Places', patch: { seg: '', focus: '' } };

/** @param {number} year */
const yearKey = year => `year:${year}`;

/** @param {Year['trips'][number]} trip */
const daysKey = trip => `days:${trip.range.first}:${trip.range.last}`;

/** @param {string} slug */
const placeKey = slug => `place:${slug}`;

/** @param {Held} held */
const editKey = held => `edit:${held.key}`;

/** @param {Places} answer */
const fingerprint = ({ position: _, ...drawn }) => JSON.stringify(drawn);

/** @param {unknown} value */
const positionOf = value => value !== null && typeof value === 'object' && 'position' in value && typeof value.position === 'string'
  ? value.position : null;

/**
 * @param {unknown} value
 * @param {unknown} held
 */
const fresher = (value, held) => {
  const at = positionOf(value);
  const was = positionOf(held);
  return at === null || was === null || atOrPast(at, was) ? value : held;
};

/** @param {string | null} id */
const keyOf = id => (id ?? '').slice((id ?? '').indexOf(':') + 1);

const CHANGED_ELSEWHERE = 'Not saved: this place changed elsewhere. Here it is now.';

/** @param {unknown} error */
const changedElsewhere = error => /** @type {{ code?: unknown }} */ (error)?.code === 'CHANGED';

/** @param {unknown} error */
const saidOf = error => {
  if (changedElsewhere(error)) return { text: CHANGED_ELSEWHERE, error: true };
  const said = actSaid(requestState(error));
  return { text: actWords(said), error: said.said !== 'saving' };
};

/**
 * @param {PlaceAction | import('../../lib/where.js').CameraAction} action
 * @param {(error: unknown) => void} [waiting]
 * @returns {Promise<string>}
 */
const ownerAct = (action, waiting) => {
  const of = action.kind === 'camera' || action.kind === 'forget' ? 'devices' : 'places';
  return actUntilAnswered({ of, ...action }, { waiting }).then(({ id }) => keyOf(id));
};

/**
 * @param {PlaceRow} row
 * @returns {Held}
 */
const placeHeld = row => ({ key: row.slug, kind: 'place', name: row.name, latitude: row.latitude, longitude: row.longitude,
  radius: row.radius_m, also: row.also });

/**
 * @param {SpotRow} spot
 * @returns {Held}
 */
const spotHeld = spot => ({ key: spot.key, kind: 'spot', name: UNNAMED, latitude: spot.latitude, longitude: spot.longitude,
  radius: SPOT_RADIUS_M, also: [] });

/**
 * @param {PlaceRow} row
 * @returns {Editing}
 */
const editingOf = row => ({ slug: row.slug, name: row.name, latitude: row.latitude, longitude: row.longitude, radius: row.radius_m,
  also: row.also, home: null });

/** @param {SpotRow} spot */
const lastOf = spot => spot.when?.kind === 'at' ? spot.when.at_ms : null;

/**
 * @param {PlaceRow} row
 * @returns {MapMark}
 */
const markOf = row => ({ key: row.slug, kind: 'place', latitude: row.latitude, longitude: row.longitude, weight: row.hours,
  name: row.name, reach: row.radius_m,
  ...(row.also.length ? { also: row.also.map(circle => ({ latitude: circle.latitude, longitude: circle.longitude,
    reach: circle.radius_m })) } : {}) });

/**
 * @param {SpotRow} spot
 * @returns {MapMark}
 */
const spotMark = spot => ({ key: spot.key, kind: 'spot', latitude: spot.latitude, longitude: spot.longitude, weight: 0, name: '' });

/** @param {City} city */
const placesIn = city => [...city.places, ...city.once];

/**
 * @param {City} city
 * @returns {MapMark}
 */
const cityMark = city => ({ key: `${CITY}${city.title}`, kind: 'city', latitude: city.point.latitude,
  longitude: city.point.longitude, weight: placesIn(city).length, name: city.title });

/**
 * @param {HTMLElement} container
 * @param {PageContext} context
 */
export function placesSection(container, context) {
  let changes = 0;
  const listReads = settledReads(container);
  const placeReads = settledReads(container);
  let cameraChanges = 0;
  const hosted = document.documentElement.classList.contains('hosted');

  /** @type {Places | null} */
  let places = null;
  /** @type {import('../../lib/reach.js').Drawn | null} */
  let placesFailed = null;
  const lacking = () => placesFailed?.kind === 'lack' ? placesFailed : null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let placesWait = null;
  let seen = '';

  /** @type {EditNote | null} */
  let note = null;
  let editing = false;
  let removing = false;
  let openFocus = context.route.focus;
  /** @type {{ focus: string, at: Sitting } | null} */
  let naming = null;
  let cardShown = '';
  let hiddenAll = false;
  /** @type {{ key: string, circles: Circle[] } | null} */
  let draft = null;
  let circleLit = 0;
  let anchor = 0;
  let asking = '';
  let resting = 0;
  /** @type {{ key: string, answer: Suggested } | null} */
  let shownNames = null;
  /** @type {Promise<void> | null} */
  let answering = null;
  /** @type {import('../../lib/places.js').ProviderNeed | null} */
  let need = null;
  /** @type {{ key: string, edit: PlaceEdit | undefined, world: CircleWorld } | null} */
  let around = null;
  let savedOf = '';

  /** @type {Map<string, Kept>} */
  const kept = new Map();
  let typed = '';
  /** @type {Set<string>} */
  const unfolded = new Set();
  /** @type {Map<string, number>} */
  const scrolled = new Map();
  /** @type {{ label: string, patch: Partial<import('../../lib/hash.js').Route> }[]} */
  let backs = [];
  const back = () => backs.at(-1) ?? TO_LIST;
  /** @type {{ slug: string, pages: PhotoPages<PlacePhoto> } | null} */
  let photos = null;
  let allVisits = false;
  let cameras = false;
  /** @type {Map<string, boolean>} */
  const yours = new Map();
  /** @type {Map<string, CameraWord>} */
  const sending = new Map();
  /** @type {Map<string, number>} */
  const answeredAt = new Map();
  let refused = '';
  /** @type {Removal | null} */
  let removal = null;
  let pageShown = '';
  let listTop = 0;
  /** @type {Record<string, MapView>} */
  let views = {};
  /** @type {string | null} */
  let listDrawn = null;

  /** @param {string} markup */
  function showList(markup) {
    if (markup === listDrawn) return;
    list.innerHTML = markup;
    listDrawn = markup;
  }

  container.innerHTML = '<div class="ck-page pp pl">'
    + `<div class="pl-stage" data-part="stage">${mapFrame('stage', 'Map of your places', 'pl-stage__map')}`
    + '<section class="pl-card ck-float" aria-label="Places" data-map-over="stage"><div class="pl-card__head" data-window-drag data-part="top"></div>'
    + '<div class="pl-card__chips" data-part="chips"></div><div class="pl-card__scroll" data-part="list"></div>'
    + '<div class="pl-card__foot" data-part="foot"></div></section>'
    + '<aside aria-label="Moment" data-part="panel"></aside></div>'
    + '<header class="ck-page__bar" data-window-drag data-part="bar"></header>'
    + '<div class="ck-under" data-part="under"><div class="ck-page__scroll" data-part="scroll"></div></div>'
    + '<div data-part="dialog"></div></div>';
  const root = /** @type {HTMLElement} */ (container.firstElementChild);
  const reach = pageReach(readHost(window), root);
  /** @param {import('../../lib/reach.js').Retry | null} [retry] */
  const readAgain = (retry = null) => void readPlaces(retry);
  const part = (/** @type {string} */ name) => /** @type {HTMLElement} */ (root.querySelector(`[data-part="${name}"]`));
  const stage = part('stage');
  const card = /** @type {HTMLElement} */ (stage.querySelector('.pl-card'));
  const top = part('top');
  const chips = part('chips');
  const list = part('list');
  const foot = part('foot');
  const bar = part('bar');
  const under = part('under');
  const scroll = part('scroll');
  const layer = part('dialog');
  installCardGrid(root);
  installChoiceRows(root);
  watchPictures(root);
  /** @type {{ row: HTMLElement, place: string } | null} */
  let opener = null;
  const panel = installMomentPanel(part('panel'), {
    go: (view, patch) => context.go(view, patch),
    closed: () => {
      if (opener?.row.isConnected) opener.row.focus({ preventScroll: true });
      opener = null;
    },
  });
  /** @param {number} at */
  const lightRow = at => {
    circleLit = at;
    for (const row of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-pl-circle]'))) {
      row.classList.toggle('is-lit', Number(row.dataset.plCircle) === at);
    }
  };
  /**
   * @param {Circle[]} was
   * @param {Circle[]} now
   */
  const anchorAfter = (was, now) => {
    const at = changedAt(was, now);
    if (now.length > was.length) return anchor >= at ? anchor + 1 : anchor;
    return anchor === at ? now.length - 1 : anchor > at ? anchor - 1 : anchor;
  };
  const maps = installMaps(root, {
    open: (id, key) => openKey(key),
    edited: (id, key, circles, live) => {
      const place = circled();
      if (!place || place.key !== key) return;
      const was = circlesNow(place);
      draft = { key, circles };
      circleShown(circles);
      const at = changedAt(was, circles);
      anchor = was.length !== circles.length ? anchorAfter(was, circles) : at < 0 ? circleLit : at;
      if (was.length !== circles.length) {
        draw();
        return;
      }
      circles.forEach((circle, at) => {
        const before = was[at];
        if (circle.latitude !== before.latitude || circle.longitude !== before.longitude || circle.radius_m !== before.radius_m) {
          showCircle(place, at, circle, live);
        }
      });
    },
    lit: (id, key, at) => lightRow(at),
    pointed: (id, key) => {
      if (id !== 'stage') return;
      for (const row of list.querySelectorAll('.ck-lrow.is-hot')) row.classList.remove('is-hot');
      if (key) list.querySelector(`.ck-lrow[data-pl-open="${CSS.escape(key)}"]`)?.classList.add('is-hot');
    },
  });

  const clock = () => ({ now: Date.now() });
  const trips = () => context.route.seg === 'trips';
  const cityOpen = () => context.route.focus.startsWith(CITY) ? context.route.focus.slice(CITY.length) : '';
  const onCities = () => context.route.seg === 'cities' || cityOpen() !== '';
  const namingOpen = () => !trips() && (context.route.focus === 'name' || context.route.focus.startsWith('spot:'));
  const placeOpen = () => {
    const { focus } = context.route;
    return trips() || namingOpen() || !focus || focus === 'hidden' || focus.startsWith(CITY) ? '' : focus;
  };
  const staged = () => !trips();
  const cities = () => places?.cities ?? [];
  /** @returns {PlaceRow[]} */
  const rows = () => cities().flatMap(placesIn);
  /** @param {string} slug */
  const rowOf = slug => rows().find(row => row.slug === slug) ?? null;
  const toName = () => places?.to_name ?? [];
  const focused = () => {
    const row = rowOf(context.route.focus);
    return row ? placeHeld(row) : null;
  };
  const year = () => Number(/^\d{4}$/u.test(context.route.on) ? context.route.on : today().slice(0, 4));
  const marks = () => [...rows().map(markOf), ...toName().map(spotMark)];
  const here = () => {
    const row = places?.here ? rowOf(places.here) : null;
    return row ? { latitude: row.latitude, longitude: row.longitude } : null;
  };
  const shownNow = () => ({ today: today(), here: places?.here ?? null, counting: places?.counting ?? false });
  const firstFrame = () => {
    const frame = places?.frame;
    return frame ? [{ latitude: frame.north, longitude: frame.east }, { latitude: frame.south, longitude: frame.west }] : [];
  };

  /** @param {Kept | undefined} read */
  const waiting = read => !read || (read.value === undefined && !read.error);

  /** @param {string} slug */
  const placeRead = slug => want(placeKey(slug), shown => placeReads.read(asked => fetchPage('place', { slug }, asked), {
    key: slug,
    counts: one => one.counting,
    land: (one, settled) => {
      if (one.counting || settled) shown(one);
      if (settled && !one.counting && photos?.slug === slug) photos.pages.again();
    },
  }).last);
  /** @returns {Place | null} */
  const opened = () => {
    const slug = placeOpen();
    return slug ? /** @type {Place | undefined} */ (kept.get(placeKey(slug))?.value) ?? null : null;
  };

  /** @param {Held} held */
  const editRead = held => want(editKey(held), () => fetchPage('placeEdit', held.kind === 'place' ? { slug: held.key }
    : { spot: held.key }));
  /**
   * @param {Held} held
   * @returns {PlaceEdit | undefined}
   */
  const editOf = held => /** @type {PlaceEdit | undefined} */ (editRead(held).value);

  function firstRead() {
    if (trips()) {
      const read = yearRead(year());
      if (waiting(read) || waiting(kept.get('atlas'))) return true;
      const trip = read.value ? tripOf(/** @type {Year} */ (read.value), context.route.focus) : null;
      return trip !== null && waiting(kept.get(daysKey(trip)));
    }
    if (!places) return !lacking();
    if (namingOpen() || context.route.focus === 'hidden') return false;
    if (placeOpen()) return rowOf(placeOpen()) !== null && waiting(kept.get(placeKey(placeOpen())));
    return false;
  }

  const saidReading = () => trips()
    ? context.route.focus.startsWith('trip:') ? 'Reading its days' : 'Reading where you were'
    : namingOpen() ? 'Reading your spots' : placeOpen() ? 'Reading this place' : 'Reading your places';

  let staging = false;

  function draw() {
    placeReads.keep(placeOpen() || null);
    const typedNow = typedValues();
    const before = openFocus;
    const focus = context.route.focus;
    if (focus !== openFocus) {
      closeEdit();
      openFocus = focus;
      if (!note?.error) note = null;
      savedOf = '';
      photos = null;
      allVisits = false;
      hiddenAll = false;
      if (!namingOpen()) naming = null;
      rested('');
    }
    views = {};
    const onStage = staged();
    stage.hidden = !onStage;
    bar.hidden = onStage;
    under.hidden = onStage;
    if (trips()) drawTrips();
    else if (namingOpen()) drawNaming();
    else if (focus === 'hidden') drawHidden();
    else if (placeOpen()) drawPlace();
    else drawStage();
    drawDialog();
    const first = firstRead();
    reading(root, first, saidReading());
    applyGeometry(root);
    restore(typedNow);
    if (!first || (staging && placeOpen() && focused())) {
      maps.settle(views);
      staging = 'stage' in views;
    }
    const shownKey = namingOpen() ? currentSpot()?.key ?? '' : '';
    if (focus !== before || shownKey !== cardShown) {
      const first = /** @type {HTMLElement | null} */ (root.querySelector('[autofocus]'));
      first?.focus();
      if (first instanceof HTMLInputElement && first.value) first.setSelectionRange(first.value.length, first.value.length);
    }
    cardShown = shownKey;
    card.classList.toggle('is-scrolled', list.scrollTop > 0);
  }

  const viewsNow = (/** @type {'places' | 'cities' | 'trips'} */ view) => {
    const read = view === 'trips' ? yearRead(year()) : null;
    const answer = /** @type {Year | undefined} */ (read?.value);
    return listViews(view, {
      places: places ? rows().length : null,
      cities: places ? cities().length : null,
      trips: answer ? answer.trips.length : !read || read.error ? undefined : null,
    });
  };

  const cardRoom = () => {
    const box = card.getBoundingClientRect();
    const frame = stage.getBoundingClientRect();
    return box.width && frame.width - box.width > 240 ? box.right - frame.left : 0;
  };

  function drawStage() {
    const name = cityOpen();
    const city = cities().find(each => each.title === name) ?? null;
    const atCities = onCities();
    context.title(name || (atCities ? 'Cities' : 'Places'));
    top.innerHTML = name
      ? cardTop({ title: name, line: city ? citySince(city) : '', back: 'Cities', placeholder: `Search in ${name}`, typed,
        hosted })
      : cardTop({ title: 'Places', placeholder: 'Search places', typed, hosted });
    chips.innerHTML = name ? '' : viewsNow(atCities ? 'cities' : 'places');
    searchWaiting(/** @type {HTMLElement} */ (top.querySelector('[data-pl-find]')), !places);
    const devices = /** @type {{ cameras: Camera[] } | undefined} */ (want('devices', fetchDevices, cameraChanges).value);
    foot.innerHTML = cardFoot(devices ? devices.cameras.length : null, places?.hidden.length ?? 0);
    const insetLeft = cardRoom();
    const points = cities().map(each => each.point);
    views.stage = name ? { frame: `${CITY}${name}`, fit: city ? placesIn(city) : [], around: AROUND_CITY_M, marks: marks(),
      here: here(), focus: null, insetLeft }
      : atCities ? { frame: 'cities', fit: points, around: fitted(points).length > 1 ? 0 : CITY_ALONE_M,
        marks: cities().map(cityMark), here: cities().find(each => each.here)?.point ?? here(), focus: null, insetLeft,
        pad: CITIES_PAD_PX }
        : { frame: 'places', fit: firstFrame(), around: 0, marks: marks(), here: here(), focus: null, insetLeft };
    const read = places ? 'ready' : lacking() ? 'failed' : 'reading';
    if (list.dataset.read !== read) list.dataset.read = read;
    if (!places) {
      showList(lacking() ? listLack() : readingAs(rowsReading()));
      return;
    }
    const all = rows();
    const spots = toName();
    if (!all.length && !spots.length) {
      const report = /** @type {import('../../types.js').StreamsReport | undefined} */ (want('phones', () => fetchConnectors()).value);
      showList(nowhereYet(report ?? null));
      return;
    }
    if (name && !city) {
      showList(noneLine('This city is not among your places now.'));
      return;
    }
    const shown = shownNow();
    const found = typed.trim() ? foundIn(city ? placesIn(city) : all, typed) : [];
    const body = typed.trim()
      ? (found.length ? `<div class="pl-group">${sectionLabel(`${found.length} found`)}`
        + `${listRows(found.map(row => placeRow(row, shown)).join(''))}</div>`
        : noneLine(`No place called “${typed}”.`))
      : city ? placeRows(city, { ...shown, open: unfolded.has(city.title) })
        : atCities ? cityRows(cities(), shown.today)
          : (spots.length ? inviteCard(spots.length) : '') + cityGroups(cities(), { ...shown, opened: unfolded });
    showList(`${editNote(note)}${body}`);
  }

  /**
   * @param {Held} held
   * @param {{ edit?: boolean, small?: boolean }} [options]
   * @returns {MapView}
   */
  function aroundOne(held, { edit = false, small = true } = {}) {
    const circles = edit ? circlesNow(held) : circlesOf(held);
    const widest = Math.max(...circles.map(circle => circle.radius_m));
    return {
      frame: held.key, fit: circles,
      around: edit ? Math.max(widest * 0.5, EDIT_ROOM_M)
        : small ? Math.max(widest * 0.6, AROUND_ONE_M - widest) : Math.max(widest * 2, AROUND_PLACE_M - widest),
      marks: edit && held.kind === 'place' ? marks().filter(mark => mark.key !== held.key) : marks(), here: here(),
      focus: { key: held.key, kind: held.kind, circles,
        ...(edit ? { edit: { world: worldOf(held), label: held.kind === 'spot' ? 'This spot' : held.name } } : {}) },
      small, ...(small ? {} : { insetLeft: cardRoom() }),
    };
  }

  const circled = () => {
    if (editing) return focused();
    const spot = namingOpen() ? currentSpot() : null;
    return spot ? spotHeld(spot) : null;
  };

  /**
   * @param {Held} held
   * @returns {Circle[]}
   */
  function circlesNow(held) {
    if (draft?.key === held.key) return draft.circles;
    if (held.kind === 'place') return circlesOf(held);
    return [editOf(held)?.circle ?? { latitude: held.latitude, longitude: held.longitude, radius_m: held.radius }];
  }

  /** @param {Circle[]} circles */
  const circleShown = circles => {
    for (const view of Object.values(views)) {
      if (view.focus?.edit && view.focus.key === draft?.key) view.focus = { ...view.focus, circles };
    }
  };

  /**
   * @param {Held} held
   * @returns {CircleWorld}
   */
  function worldOf(held) {
    const edit = editOf(held);
    if (around?.key === held.key && around.edit === edit) return around.world;
    const own = edit?.slug ?? held.key;
    const world = {
      slug: own,
      points: (edit?.points ?? []).map(point => ({ latitude: point.latitude, longitude: point.longitude })),
      spots: [],
      others: (edit?.others ?? []).filter(other => other.slug !== own).map(other => ({ key: other.slug,
        name: rowOf(other.slug)?.name ?? '', latitude: other.latitude, longitude: other.longitude, radius_m: other.radius_m })),
    };
    around = { key: held.key, edit, world };
    return world;
  }

  /** @param {Held} held */
  function lineOf(held) {
    const edit = editOf(held);
    if (!edit) return '';
    return edit.read ? takesInWords(draggedStays(edit, circlesNow(held))) : edit.line ?? '';
  }

  /**
   * @param {Held} held
   * @param {number} at
   * @param {Circle} circle
   * @param {boolean} live
   */
  function showCircle(held, at, circle, live) {
    showReach(root, at, circle.radius_m, live);
    const line = lineOf(held);
    circlesNow(held).forEach((_, index) => showLine(root, index, line, live));
    listDrawn = null;
  }

  function drawPlace() {
    const slug = placeOpen();
    const row = rowOf(slug);
    chips.innerHTML = '';
    foot.innerHTML = '';
    if (places && !row) {
      context.title('Places');
      top.innerHTML = placeTop({ back: back().label, name: null, one: null, today: today() });
      showList(noneLine('This place is not among your places now.'));
      return;
    }
    const read = placeRead(slug);
    const one = /** @type {Place | undefined} */ (read.value) ?? null;
    const held = row ? placeHeld(row) : null;
    context.title(held?.name ?? '');
    if (editing && held) {
      top.innerHTML = editTop();
      const line = lineOf(held);
      showList(editBody({ name: held.name, note, lit: circleLit, circles: circlesNow(held).map(circle => ({
        metres: circle.radius_m, line })) }));
      foot.innerHTML = editFoot(removing);
      views.stage = { ...aroundOne(held, { edit: true, small: false }), frame: `edit:${held.key}` };
      return;
    }
    top.innerHTML = placeTop({ back: back().label, name: held?.name ?? null, one, today: today() });
    if (held) views.stage = aroundOne(held, { small: false });
    if (!held || !one) {
      showList(lacking() && !places ? listLack() : read.error ? retryLine(read.error) : readingAs(placeBodyReading()));
      return;
    }
    if (one.photos.total) photosOf(slug);
    const saved = savedOf === slug && note && !note.error && !read.pending && !one.counting
      ? { text: `${note.text} · ${takesInWords(one.stays)}`, error: false } : note;
    showList(editNote(saved) + placeBody({ one, allVisits, rowOf, shown: shownNow(), now: Date.now() }));
  }


  function sittingNow() {
    const focus = context.route.focus;
    if (!namingOpen() || !places) return null;
    if (naming?.focus !== focus) {
      const keys = focus === 'name' ? toName().map(spot => spot.key) : [focus];
      naming = { focus, at: startSitting(keys, Date.now()) };
    }
    return naming.at;
  }

  /** @param {string} key */
  const spotOf = key => toName().find(spot => spot.key === key) ?? null;

  function currentSpot() {
    const at = sittingNow();
    if (!at || at.ended) return null;
    const spotAt = (/** @type {string | undefined} */ key) => key === undefined ? null
      : spotOf(key) ?? (at.brought?.key === key ? at.brought : null);
    if (context.route.focus.startsWith('spot:')) return spotAt(at.keys[at.at]);
    while (at.at < at.keys.length && !spotAt(at.keys[at.at])) at.at += 1;
    return spotAt(at.keys[at.at]);
  }

  /**
   * @param {SpotRow} spot
   * @param {string} words
   */
  const namesRead = (spot, words) => want(`suggest:${spot.key}|${words}`,
    () => fetchSuggestions({ spot: spot.key, q: words }).catch(error => {
      if (/** @type {{ code?: string }} */ (error).code === 'SPOT_UNKNOWN') {
        changes += 1;
        void readPlaces();
      }
      throw error;
    }), 0);

  /**
   * @param {SpotRow} spot
   * @returns {{ answer: Suggested | null, error: string }}
   */
  function namesNow(spot) {
    const key = `suggest:${spot.key}|${asking}`;
    const under = [...kept].some(([each, read]) => each.startsWith(`suggest:${spot.key}|`) && each !== key && read.pending);
    const read = kept.has(key) || !under ? namesRead(spot, asking) : null;
    const answer = /** @type {Suggested | undefined} */ (read?.value);
    if (answer) {
      shownNames = { key: spot.key, answer };
      if (answer.provider) need = answer.provider.need;
    }
    const last = shownNames?.key === spot.key ? shownNames.answer : null;
    return { answer: answer ?? last, error: answer || last ? '' : read?.error ?? '' };
  }

  const rowsNow = () => {
    const spot = currentSpot();
    return spot && naming ? rowsOf(namesNow(spot).answer?.suggestions ?? [], naming.at.typed) : [];
  };

  /** @param {string} typed */
  function rested(typed) {
    clearTimeout(resting);
    const words = askedWords(typed);
    if (!words || words === asking) {
      asking = words;
      return;
    }
    resting = window.setTimeout(() => {
      asking = words;
      drawRows();
    }, TYPED_REST_MS);
  }

  /** @param {SpotRow} spot */
  const spotPhotos = spot => spot.photos.map((hash, index) => ({ hash, label: `Photo ${index + 1} of ${spot.photos_total}` }));

  function drawNaming() {
    const at = sittingNow();
    const alone = context.route.focus.startsWith('spot:');
    chips.innerHTML = '';
    if (!at) {
      context.title('Name this place');
      top.innerHTML = namingTop(null);
      foot.innerHTML = '';
      showList(lacking() ? listLack() : readingAs(namingReading()));
      return;
    }
    const spot = currentSpot();
    if (!spot && !at.ended) {
      if (at.pending > 0) {
        context.title('Name this place');
        top.innerHTML = namingTop(alone ? null : { at: at.keys.length, of: at.keys.length });
        foot.innerHTML = '';
        showList('');
        return;
      }
      if (at.named.length && !alone) at.ended = true;
      else if (alone) {
        context.title('Name this place');
        top.innerHTML = namingTop(null);
        foot.innerHTML = '';
        showList(noneLine('This spot is not among your spots now.'));
        return;
      } else {
        showList('');
        queueMicrotask(leave);
        return;
      }
    }
    if (at.ended) {
      drawFinish(at);
      return;
    }
    const shown = /** @type {SpotRow} */ (spot);
    const held = spotHeld(shown);
    const { answer, error } = namesNow(shown);
    const next = at.keys.slice(at.at + 1).map(spotOf).find(Boolean);
    if (next) namesRead(next, '');
    context.title('Name this place');
    const asking = Boolean(shown.ask && !at.home.has(shown.key));
    top.innerHTML = namingTop(alone ? null : { at: at.at + 1, of: at.keys.length }, asking ? 'Is this home?' : undefined);
    foot.innerHTML = namingFoot(!alone, need, { ready: canSave(at),
      refused: at.refused?.key === shown.key, ask: asking });
    const rows = rowsOf(answer?.suggestions ?? [], at.typed);
    const [circle] = circlesNow(held);
    showList(namingBody({
      key: shown.key, typed: at.typed, placeholder: namePlaceholder(rows), ask: asking && shown.ask ? askLine(shown.ask, today()) : null,
      photos: spotPhotos(shown),
      witnessed: shown.line, last: shown.when ? `Last time ${whenWords(shown.when, today())}` : '',
      reach: { metres: held.radius, line: '' },
      rows: answer || error ? nameRows(rows, at.lit, { typed: at.typed, last: lastOf(shown) }) : null,
      credit: fromGoogle(rows), error, refused: at.refused?.key === shown.key ? at.refused.text : '',
    }));
    showNamingReach(circle.radius_m, lineOf(held));
    views.stage = { ...aroundOne(held, { edit: true, small: false }), around: Math.max(0, AROUND_ONE_M - circle.radius_m),
      marks: marks() };
  }

  /**
   * @param {number} metres
   * @param {string} line
   */
  function showNamingReach(metres, line) {
    showReach(list, 0, metres);
    if (list.querySelector('[data-ck-circle-line="0"]')?.textContent !== line) showLine(list, 0, line, false);
  }

  function drawRows() {
    const spot = currentSpot();
    const box = list.querySelector('[data-pl-rows]');
    if (!spot || !box || !naming) return;
    listDrawn = null;
    const rows = rowsNow();
    const { typed, lit } = naming.at;
    box.innerHTML = nameRows(rows, lit, { typed, last: lastOf(spot) });
    list.querySelector('#place-name')?.setAttribute('placeholder', namePlaceholder(rows));
    const credit = list.querySelector('[data-pl-credit]');
    if (credit) credit.innerHTML = fromGoogle(rows) ? nameCredit('Google') : '';
    foot.innerHTML = namingFoot(!context.route.focus.startsWith('spot:'), need, { ready: canSave(naming.at),
      refused: naming.at.refused?.key === spot.key });
  }

  /** @param {Sitting} at */
  function drawFinish(at) {
    context.title(finishWords(at).title);
    top.innerHTML = '';
    foot.innerHTML = finishFoot();
    showList(finishBody({ words: finishWords(at), named: at.named, at: clock() }));
    const lit = new Set(at.named.map(place => place.slug));
    views.stage = { frame: 'named', fit: at.named, around: AROUND_PLACE_M, marks: marks().filter(mark => !lit.has(mark.key)),
      lit: at.named.map(place => ({ latitude: place.latitude, longitude: place.longitude, name: place.name })), here: null,
      focus: null, insetLeft: cardRoom() };
  }

  function drawHidden() {
    chips.innerHTML = '';
    foot.innerHTML = '';
    context.title('Hidden spots');
    const spots = places?.hidden ?? [];
    top.innerHTML = hiddenTop(spots.length);
    if (!places) {
      showList(lacking() ? listLack() : readingAs(rowsReading()));
      return;
    }
    views.stage = { frame: 'hidden', fit: spots.length ? spots : firstFrame(), around: AROUND_HIDDEN_M,
      marks: [...marks(), ...spots.map(spot => ({ key: spot.key, latitude: spot.latitude, longitude: spot.longitude,
        kind: /** @type {const} */ ('spot'), weight: 0, name: '' }))],
      here: null, focus: spots[0] ? { key: spots[0].key, kind: 'spot', circles: [{ latitude: spots[0].latitude,
        longitude: spots[0].longitude, radius_m: SPOT_RADIUS_M }] } : null,
      insetLeft: cardRoom() };
    showList(editNote(note) + hiddenPage({ spots, all: hiddenAll, at: clock() }));
  }

  function drawTrips() {
    const shown = year();
    const read = yearRead(shown);
    const atlas = want('atlas', fetchAtlas);
    const world = /** @type {World | undefined} */ (atlas.value) ?? null;
    const answer = /** @type {Year | undefined} */ (read.value);
    const span = answer?.span ?? { first: shown, last: shown };
    const trip = answer ? tripOf(answer, context.route.focus) : null;
    if (context.route.focus.startsWith('trip:') && waiting(read)) {
      context.title('Trips');
      bar.innerHTML = pageBar('Trips', '');
      scroll.innerHTML = `<div class="ck-page__body ck-page__body--one"><div class="ck-page__main pp-main">${tripPageReading()}</div></div>`;
      return;
    }
    if (context.route.focus && trip && answer) {
      context.title(trip.title);
      bar.innerHTML = pageBar('Trips', trip.title);
      const days = want(daysKey(trip), () => fetchWhere({ from: trip.range.first, to: trip.range.last, grain: 'day' }));
      scroll.innerHTML = '<div class="ck-page__body ck-page__body--one"><div class="ck-page__main pp-main">' + tripPage({
        trip, year: answer, world, width: Math.min(1000, root.clientWidth - 48), today: today(),
        days: /** @type {{ summaries: Summary[] } | undefined} */ (days.value)?.summaries ?? null,
      }) + '</div></div>';
      return;
    }
    context.title('Trips');
    bar.innerHTML = listBar(typed, hosted, yearStepper(shown, span));
    searchWaiting(/** @type {HTMLElement} */ (bar.querySelector('[data-pl-find]')), !places);
    const body = read.error && read.value === undefined ? retryLine(read.error)
      : answer && (world || atlas.error) ? tripsBody({ year: answer, world, width: Math.min(1000, root.clientWidth - 48) })
        : tripsReading();
    scroll.innerHTML = '<div class="ck-page__body ck-page__body--one">'
      + `<div class="ck-page__main pp-main">${viewsNow('trips')}<div class="pl-trips ${ARRIVES}">${body}</div>${answer?.trips.length ? credit() : ''}</div></div>`;
  }

  function drawDialog() {
    let markup = '';
    if (cameras) {
      const read = want('devices', fetchDevices, cameraChanges);
      const answer = /** @type {{ cameras: Camera[], source: string | null } | undefined} */ (read.value);
      if (!read.pending && !read.error) {
        for (const [camera, at] of answeredAt) {
          if (read.at < at) continue;
          answeredAt.delete(camera);
          sending.delete(camera);
        }
      }
      const day = today();
      for (const camera of answer?.cameras ?? []) {
        if (!read.pending && !yours.has(camera.camera)) yours.set(camera.camera, camera.mine);
      }
      const asked = removal && answer?.cameras.find(camera => camera.camera === removal?.camera);
      if (removal && asked) markup = removePage(asked, removal, day);
      else {
        removal = null;
        if (answer || read.error) {
          markup = camerasDialog({ cameras: answer?.cameras ?? null, source: answer?.source ?? null, sending, yours,
            refused, failed: read.error ?? '' });
        }
      }
    }
    if (layer.dataset.drawn === markup) return;
    const page = markup && removal ? removal.camera : '';
    const turned = page !== pageShown;
    if (turned && page) listTop = layer.querySelector('.ck-dialog__body')?.scrollTop ?? 0;
    put(layer, markup, { keep: '.ck-dialog', scroll: !turned });
    layer.dataset.drawn = markup;
    for (const behind of [bar, scroll, stage]) behind.inert = markup !== '';
    if (turned && markup) {
      const body = layer.querySelector('.ck-dialog__body');
      if (body && !page) {
        body.scrollTop = listTop;
        body.closest('.ck-dialog')?.classList.toggle('is-scrolled', body.scrollTop > 0);
      }
      /** @type {HTMLElement | null} */ (page ? layer.querySelector('.ck-choice[tabindex="0"]')
        : layer.querySelector(`.ck-toggle[data-pl-camera="${CSS.escape(pageShown)}"]`))?.focus();
    }
    pageShown = page;
  }

  /** @returns {Camera[]} */
  const camerasShown = () => /** @type {{ cameras: Camera[] } | undefined} */ (kept.get('devices')?.value)?.cameras ?? [];

  /** @param {number} shown */
  const yearRead = shown => want(yearKey(shown), () => fetchPage('year', { year: String(shown) }));

  /**
   * @param {string} key
   * @param {(shown: (value: unknown) => boolean) => Promise<unknown>} load
   * @param {number} [moved]
   * @returns {Kept}
   */
  function want(key, load, moved = changes) {
    const entry = kept.get(key);
    if (entry && (entry.at === moved || entry.pending)) return entry;
    const asked = moved;
    /** @type {Kept} */
    const next = { ...entry, at: entry?.at ?? -1, pending: true };
    kept.set(key, next);
    const owns = () => kept.get(key) === next;
    load(value => {
      if (!owns()) return false;
      next.value = fresher(value, entry?.value);
      draw();
      return true;
    }).then(value => {
      if (owns()) kept.set(key, { value: fresher(value, entry?.value), at: asked });
    }, (/** @type {Error} */ error) => {
      if (!owns()) return;
      kept.set(key, { ...(entry?.value !== undefined ? { value: entry.value } : {}), error: wordsOf(error), at: asked });
    }).finally(() => {
      draw();
    });
    return next;
  }

  /** @param {string} message */
  const retryLine = message => pageLack(message, { retry: { 'data-pl-retry': '' } });
  const listLack = () => {
    const lack = lacking();
    return lack ? pageLack(lack.words ?? 'Your places couldn’t be read.', lack.retry ? { retry: { 'data-pl-retry': '' } } : {}) : '';
  };
  /** @param {string} markup */
  const readingAs = markup => placesFailed && placesFailed.kind !== 'lack'
    ? markup.replace(waitLine(), readingAgain(placesFailed, 'Your places aren’t on this Mac yet.')) : markup;
  /** @param {unknown} error */
  const wordsOf = error => wordsOr(error, 'This couldn’t be read.');


  let reads = 0;
  /** @type {string | null} */
  let listAt = null;

  /** @param {import('../../lib/reach.js').Retry | null} [retry] */
  async function readPlaces(retry = null) {
    const mine = ++reads;
    const begun = reach.begin(retry);
    if (placesWait !== null) clearTimeout(placesWait);
    placesWait = null;
    try {
      await listReads.read(asked => fetchPage('places', {}, asked), {
        counts: answer => answer.counting,
        land: answer => {
          if (mine !== reads) return;
          placesFailed = null;
          if (listAt !== null && !atOrPast(answer.position, listAt)) return;
          listAt = answer.position;
          const now = fingerprint(answer);
          if (now === seen) return;
          seen = now;
          places = answer;
          draw();
        },
      }).first;
    } catch (error) {
      if (mine !== reads || places) return;
      placesFailed = reach.failed(error, begun, readAgain);
      if (placesFailed.kind === 'wait') placesWait = setTimeout(() => readAgain(), Math.max(0, placesFailed.until - Date.now()));
      draw();
    }
  }

  /** @param {boolean} [own] */
  async function acted(own = false) {
    changes += 1;
    if (own) {
      listReads.want();
      if (placeOpen()) placeReads.want(placeOpen());
    }
    await readPlaces();
  }

  /**
   * @param {PlaceAction} action
   * @returns {Promise<string | null>}
   */
  async function save(action) {
    if (!places) return null;
    note = { text: 'Saving…', error: false };
    draw();
    try {
      const key = await ownerAct(action, error => {
        note = saidOf(error);
        draw();
      });
      await acted(true);
      note = { text: 'Saved', error: false };
      savedOf = action.kind === 'edit' && ('radius_m' in action || 'latitude' in action || 'also' in action) ? action.slug : '';
      return key;
    } catch (error) {
      note = saidOf(error);
      if (changedElsewhere(error)) {
        closeEdit();
        await acted().catch(() => undefined);
      }
      return null;
    } finally {
      removing = false;
      draw();
    }
  }

  /**
   * @param {PlaceAction} action
   * @returns {Promise<{ refused: string, key: string }>}
   */
  async function ship(action) {
    try {
      const key = await ownerAct(action);
      await acted(true);
      return { refused: '', key };
    } catch (error) {
      if (changedElsewhere(error)) await acted().catch(() => undefined);
      return { refused: saidOf(error).text, key: '' };
    }
  }

  /**
   * @param {SpotRow} spot
   * @param {{ name: string, ids: string[] } | { slug: string } | 'hide'} said
   */
  async function answer(spot, said) {
    const at = naming?.at;
    if (!at || !places) return;
    const alone = context.route.focus.startsWith('spot:');
    const circles = circlesNow(spotHeld(spot));
    const [circle] = circles;
    const centre = { latitude: stated(circle.latitude), longitude: stated(circle.longitude) };
    const asked = said !== 'hide' && 'slug' in said ? said.slug : null;
    const own = asked === null ? null : rowOf(asked);
    if (asked !== null && !own) return;
    const isHome = at.home.get(spot.key);
    /** @type {PlaceAction | null} */
    const action = said === 'hide' ? { kind: 'hide', latitude: spot.latitude, longitude: spot.longitude }
      : own ? { kind: 'add-circle', slug: own.slug, ...centre, radius_m: circle.radius_m }
        : 'name' in said ? { kind: 'create', name: said.name, ...centre, radius_m: circle.radius_m, ids: said.ids,
          ...(isHome === undefined ? {} : { home: isHome }) }
          : null;
    if (!action) return;
    const name = action.kind === 'create' ? action.name.trim() : own?.name ?? '';
    const last = lastOf(spot);
    /** @type {Named | null} */
    const named = name ? { key: spot.key, slug: own?.slug ?? '', name, ...centre, city: spot.city,
      day: last === null ? '' : dayAt(last).day } : null;
    const card = { typed: at.typed, lit: at.lit, circles };
    const act = (at.acts += 1);
    at.refused = null;
    at.taken = null;
    at.brought = null;
    at.pending += 1;
    if (!alone) {
      if (named) {
        at.named.push(named);
        at.last_ms = Date.now();
      }
      at.typed = '';
      at.lit = 0;
      at.at += 1;
      rested('');
    }
    const shipping = ship(action);
    const waited = shipping.then(() => {
      if (answering === waited) answering = null;
    });
    if (!alone) answering = waited;
    const { refused, key } = await shipping;
    if (named && !refused && action.kind === 'create') named.slug = key;
    at.pending -= 1;
    if (naming?.at !== at) {
      if (refused) {
        note = { text: refused, error: true };
        draw();
      }
      return;
    }
    if (refused) {
      at.refused = { key: spot.key, text: refused };
      at.named = at.named.filter(each => each !== named);
      at.at = at.keys.indexOf(spot.key);
      at.ended = false;
      at.typed = card.typed || named?.name || '';
      at.lit = card.lit;
      draft = { key: spot.key, circles: card.circles };
    } else if (alone) {
      if (!named) {
        leave();
        return;
      }
      naming = null;
      placeReads.want(named.slug);
      context.set({ focus: named.slug }, true);
    } else if (at.acts === act) {
      /** @type {PlaceAction | null} */
      const back = action.kind === 'add-circle' && own
        ? placeEdit({ ...editingOf(own), also: [...own.also, { latitude: action.latitude, longitude: action.longitude,
          radius_m: action.radius_m }] }, { also: own.also })
        : action.kind === 'create' ? { kind: 'remove', slug: key } : { kind: 'unhide', key };
      if (back) at.taken = { spot, circles, named, back };
    }
    draw();
  }

  async function undo() {
    if (answering) await answering;
    const at = naming?.at;
    const taken = at?.taken;
    if (!at || !taken) return;
    at.acts += 1;
    at.taken = null;
    at.named = at.named.filter(each => each !== taken.named);
    at.home.delete(taken.spot.key);
    at.brought = taken.spot;
    draft = { key: taken.spot.key, circles: taken.circles };
    at.at = at.keys.indexOf(taken.spot.key);
    at.ended = false;
    at.typed = '';
    at.lit = 0;
    at.refused = null;
    rested('');
    at.pending += 1;
    const { refused } = await ship(taken.back);
    at.pending -= 1;
    if (refused && naming?.at === at) at.refused = { key: taken.spot.key, text: refused };
    draw();
  }

  /** @param {Suggestion} suggestion */
  function takeName(suggestion) {
    const spot = currentSpot();
    if (!spot) return;
    void answer(spot, suggestion.slug ? { slug: suggestion.slug }
      : { name: suggestion.name, ids: suggestion.id ? [suggestion.id] : [] });
  }

  /** @param {number} index */
  function take(index) {
    const row = rowsNow()[index];
    if (row) takeName(row);
  }

  function saveField() {
    const spot = currentSpot();
    const typed = naming?.at.typed.trim() ?? '';
    if (!spot || !typed) return;
    const listed = fieldName(typed, namesNow(spot).answer?.suggestions ?? []);
    if (listed) takeName(listed);
    else void answer(spot, { name: typed, ids: [] });
  }

  function skip() {
    const at = naming?.at;
    if (!at) return;
    if (context.route.focus.startsWith('spot:')) {
      leave();
      return;
    }
    at.at += 1;
    at.typed = '';
    at.lit = 0;
    at.refused = null;
    at.brought = null;
    rested('');
    draw();
  }

  function end() {
    const at = naming?.at;
    if (at && at.named.length && !context.route.focus.startsWith('spot:')) {
      at.ended = true;
      draw();
    } else leave();
  }

  function leave() {
    naming = null;
    const to = back();
    backs = backs.slice(0, -1);
    go(to.patch);
  }

  /**
   * @param {PlaceVisit} visit
   * @param {boolean} open
   * @param {HTMLElement} row
   */
  function openVisit(visit, open, row) {
    opener = { row, place: context.route.focus };
    const { date, span } = visitWords(visit, clock(), open);
    const head = { icon: 'place', title: focused()?.name ?? '', meta: `${date} · ${span}` };
    panel.show([{ on: visit.day, focus: visit.focus, head }], 0);
  }

  /** @param {string} slug */
  function photosOf(slug) {
    if (photos?.slug !== slug) {
      /** @type {PhotoPages<PlacePhoto>} */
      const pages = photoPages((at, limit) => fetchPlacePhotos(slug, { at, limit }), () => {
        if (photos?.pages === pages) draw();
      });
      photos = { slug, pages };
      pages.again();
    }
    return photos.pages;
  }


  /**
   * @param {string} camera
   * @param {CameraWord} said
   */
  async function word(camera, said) {
    if (sending.has(camera)) return;
    sending.set(camera, said);
    refused = '';
    draw();
    try {
      await ownerAct(cameraAction(camera, said), error => {
        refused = saidOf(error).text;
        draw();
      });
      refused = '';
      cameraChanges += 1;
      answeredAt.set(camera, cameraChanges);
    } catch (error) {
      refused = saidOf(error).text;
      sending.delete(camera);
    }
    draw();
  }


  const routeKey = () => `${context.route.seg}|${context.route.focus}`;

  /** @param {Partial<import('../../lib/hash.js').Route>} patch */
  const go = patch => {
    maps.emphasise('stage', '');
    scrolled.set(routeKey(), staged() ? list.scrollTop : scroll.scrollTop);
    context.set(patch, true);
    draw();
    const at = scrolled.get(routeKey()) ?? 0;
    if (staged()) list.scrollTop = at;
    else scroll.scrollTop = at;
  };

  /** @param {string} key */
  function openKey(key) {
    if (key.startsWith(CITY)) {
      typed = '';
      go({ seg: 'cities', focus: key, on: '' });
      return;
    }
    const city = cityOpen();
    const from = placeOpen();
    if (from) backs.push({ label: focused()?.name ?? 'Places', patch: { seg: context.route.seg, focus: from } });
    else {
      backs = [staged() && city ? { label: city, patch: { seg: 'cities', focus: `${CITY}${city}` } }
        : { label: 'Places', patch: { seg: staged() ? context.route.seg : '', focus: '' } }];
    }
    scrolled.delete(`${context.route.seg}|${key}`);
    go({ focus: key });
  }

  function closeEdit() {
    draft = null;
    removing = false;
    if (!editing) return;
    editing = false;
    const on = openFocus;
    queueMicrotask(() => {
      if (openFocus !== on) return;
      list.scrollTop = scrolled.get(routeKey()) ?? 0;
      /** @type {HTMLElement | null} */ (top.querySelector('[data-pl-edit]'))?.focus({ preventScroll: true });
    });
  }

  /** @type {Record<string, (control: HTMLElement) => void>} */
  const actions = {
    plSeg: control => {
      typed = '';
      go({ seg: control.dataset.plSeg ?? '', focus: '', on: '' });
    },
    plCity: control => openKey(`${CITY}${control.dataset.plCity}`),
    plOnce: control => {
      const city = String(control.dataset.plOnce);
      if (unfolded.has(city)) unfolded.delete(city);
      else unfolded.add(city);
    },
    plOpen: control => openKey(String(control.dataset.plOpen)),
    plBack: () => {
      if (staged() && cityOpen()) {
        typed = '';
        go({ seg: 'cities', focus: '' });
      } else if (trips()) go({ focus: '' });
      else {
        const to = back();
        backs = backs.slice(0, -1);
        go(to.patch);
      }
    },
    plStep: control => context.set({ on: String(year() + Number(control.dataset.plStep)), focus: '' }),
    plEdit: () => {
      scrolled.set(routeKey(), list.scrollTop);
      editing = true;
      circleLit = 0;
      anchor = 0;
      draw();
      const field = /** @type {HTMLInputElement | null} */ (list.querySelector('form[data-pl-form="edit"] input[name=name]'));
      field?.focus({ preventScroll: true });
      field?.setSelectionRange(field.value.length, field.value.length);
    },
    plClose: () => {
      if (editing) closeEdit();
      cameras = false;
      yours.clear();
      refused = '';
      removal = null;
    },
    plCameras: () => {
      cameras = true;
    },
    plConnect: control => context.dialog(String(control.dataset.plConnect)),
    plDay: control => context.go('days', { on: String(control.dataset.plDay) }),
    plPerson: control => context.go('people', { focus: String(control.dataset.plPerson) }),
    plVisit: control => {
      const one = opened();
      const at = one ? one.visits.rows.findIndex(visit => visit.key === control.dataset.plVisit) : -1;
      if (one && at >= 0) openVisit(one.visits.rows[at], at === 0 && one.here, control);
    },
    plVisits: () => {
      allVisits = true;
    },
    plHome: control => {
      const row = rowOf(context.route.focus);
      const edit = row ? placeEdit(editingOf(row), { home: control.dataset.plHome === 'true' }) : null;
      if (edit) void save(edit);
    },
    plPhoto: control => {
      const one = opened();
      if (!one || !photos) return;
      openPhotoPages(photos.pages, Number(control.dataset.plPhoto), photo => `sha256:${photo.image}`,
        index => /** @type {HTMLElement} */ (list.querySelector(`[data-pl-photo="${index}"]`) ?? control).focus({ preventScroll: true }),
        one.photos.total);
    },
    plReach: control => {
      const place = circled();
      if (!place) return;
      const at = Number(/** @type {HTMLElement | null} */ (control.closest('[data-pl-circle]'))?.dataset.plCircle ?? 0);
      const circles = circlesNow(place);
      const next = { ...circles[at], radius_m: notch(circles[at].radius_m, Number(control.dataset.plReach) > 0 ? 1 : -1) };
      draft = { key: place.key, circles: circles.map((circle, index) => index === at ? next : circle) };
      anchor = at;
      showCircle(place, at, next, false);
      circleShown(draft.circles);
      maps.settle(views);
    },
    plUncircle: control => {
      const place = circled();
      const circles = place ? circlesNow(place) : [];
      if (!place || circles.length < 2) return;
      const at = Number(control.dataset.plUncircle);
      draft = { key: place.key, circles: circles.filter((_, index) => index !== at) };
      anchor = anchorAfter(circles, draft.circles);
      draw();
      /** @type {HTMLElement | null} */ (list.querySelector(`[data-pl-uncircle="${Math.min(at, circles.length - 2)}"]`)
        ?? list.querySelector('[data-pl-circle] [data-pl-reach]'))?.focus({ preventScroll: true });
    },
    plAddCircle: () => {
      const place = circled();
      const circles = place ? circlesNow(place) : [];
      if (!place || circles.length >= CIRCLES_MAX) return;
      draft = { key: place.key, circles: [...circles, besideCircle(circles, Math.min(anchor, circles.length - 1), toName())] };
      circleLit = circles.length;
      anchor = circleLit;
      draw();
      list.querySelector('[data-pl-add-circle]')?.scrollIntoView({ block: 'nearest' });
      maps.light('stage', circleLit, true);
    },
    plRemove: () => {
      const place = focused();
      if (!place) return;
      if (!removing) {
        removing = true;
        queueMicrotask(() => /** @type {HTMLElement | null} */ (foot.querySelector('[data-pl-keep]'))?.focus());
        return;
      }
      void save({ kind: 'remove', slug: place.key }).then(slug => {
        if (slug !== null) {
          editing = false;
          const to = back();
          backs = backs.slice(0, -1);
          context.set(to.patch, true);
        }
        draw();
      });
    },
    plKeep: () => {
      removing = false;
      queueMicrotask(() => /** @type {HTMLElement | null} */ (foot.querySelector('[data-pl-remove]'))?.focus());
    },
    plTake: control => take(Number(control.dataset.plTake)),
    plSkip: () => skip(),
    plSaveName: () => {
      if (naming?.at.typed.trim()) saveField();
      else if (naming && naming.at.lit >= 0) take(naming.at.lit);
      else list.querySelector('input')?.focus();
    },
    plHide: () => {
      const spot = currentSpot();
      if (spot) void answer(spot, 'hide');
    },
    plEnd: () => end(),
    plDone: () => leave(),
    plSpotHome: control => {
      const spot = currentSpot();
      const at = naming?.at;
      if (!spot || !at) return;
      const yes = control.dataset.plSpotHome === 'true';
      at.home.set(spot.key, yes);
      at.typed = yes ? HOME_NAME : '';
      at.lit = litFor(at.typed);
      rested(at.typed);
      draw();
      const field = /** @type {HTMLInputElement | null} */ (list.querySelector('form[data-pl-form="name"] input'));
      field?.focus({ preventScroll: true });
      field?.setSelectionRange(at.typed.length, at.typed.length);
    },
    plRetryNames: () => {
      const spot = currentSpot();
      if (spot) kept.delete(`suggest:${spot.key}|${asking}`);
      draw();
    },
    plSpotPhoto: control => {
      const spot = currentSpot();
      if (!spot) return;
      openPhotoViewer(spot.photos, Number(control.dataset.plSpotPhoto),
        { closed: () => control.focus({ preventScroll: true }) });
    },
    plUnhide: control => {
      void ship({ kind: 'unhide', key: String(control.dataset.plUnhide) }).then(({ refused }) => {
        note = refused ? { text: refused, error: true } : null;
        draw();
      });
    },
    plHiddenAll: () => {
      hiddenAll = true;
    },
    plMine: control => void word(String(control.dataset.plCamera), { mine: control.dataset.plMine === 'true' }),
    plAskWhy: control => {
      const camera = camerasShown().find(each => each.camera === control.dataset.plCamera);
      const dayOf = (/** @type {number | null | undefined} */ ms) => ms == null ? '' : dayAt(ms).day;
      removal = { camera: String(control.dataset.plCamera), why: '', when: '', stopped: '', first: dayOf(camera?.first_ms),
        last: dayOf(camera?.last_ms) };
    },
    plWhy: control => {
      if (!removal) return;
      const why = control.dataset.plWhy === 'never' ? 'never' : 'stopped';
      removal = { ...removal, why, when: removal.when || (removal.last ? 'last' : 'day') };
    },
    plWhen: control => {
      if (removal) removal = { ...removal, when: control.dataset.plWhen === 'day' ? 'day' : 'last' };
    },
    plWhyBack: () => {
      removal = null;
    },
    plUnmine: () => {
      const asked = removal;
      const camera = camerasShown().find(each => each.camera === asked?.camera);
      removal = null;
      draw();
      if (!asked || !camera) return;
      void layer.offsetWidth;
      const said = removalWord(camera, asked, today());
      if (said) void word(camera.camera, said);
      /** @type {HTMLElement | null} */ (layer.querySelector(`[data-pl-row="${CSS.escape(camera.camera)}"]`))?.focus();
    },
    plCamerasAgain: () => {
      cameraChanges += 1;
    },
    plCount: control => void word(String(control.dataset.plCamera), 'count'),
    plRetry: () => {
      changes += 1;
      void readPlaces();
    },
  };
  const quiet = new Set(['plEdit', 'plReach', 'plUncircle', 'plAddCircle', 'plSeg', 'plCity', 'plOpen', 'plBack',
    'plHome', 'plPhoto', 'plPhotos', 'plVisit', 'plTake', 'plSkip', 'plHide', 'plEnd', 'plDone', 'plSpotHome',
    'plSpotPhoto', 'plUnhide', 'plUnmine']);
  const selector = Object.keys(actions)
    .map(key => `[data-${key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}]`).join(',');

  restOn(root, '.ck-lrow[data-pl-open]', on => {
    const row = rowOf(String(on.dataset.plOpen));
    if (row) placeRead(row.slug);
  });
  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    if (target.matches('[data-scrim]')) {
      actions.plClose(/** @type {HTMLElement} */ (target));
      draw();
      return;
    }
    const control = /** @type {HTMLElement | null} */ (target.closest(selector));
    if (!control || control.matches(':disabled')) return;
    const name = Object.keys(actions).find(key => key in control.dataset);
    if (!name) return;
    actions[name](control);
    if (!quiet.has(name)) draw();
  });

  root.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains('pl-camera__sample')) return;
    const tile = sampleTile();
    if (image.dataset.keep) tile.setAttribute('data-keep', image.dataset.keep);
    image.replaceWith(tile);
  }, true);

  root.addEventListener('submit', event => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.target);
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const row = rowOf(context.route.focus);
    if (form.dataset.plForm === 'name') {
      saveField();
    } else if (form.dataset.plForm === 'edit' && row && editing) {
      const [first, ...also] = circlesNow(placeHeld(row))
        .map(circle => ({ latitude: stated(circle.latitude), longitude: stated(circle.longitude), radius_m: circle.radius_m }));
      const edit = placeEdit(editingOf(row), { name, ...first, also });
      if (!edit) {
        closeEdit();
        draw();
        return;
      }
      void save(edit).then(saved => {
        if (saved === null) return;
        closeEdit();
        draw();
      });
    }
  });

  root.addEventListener('input', event => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (input.matches('[data-pl-find]')) {
      typed = input.value;
      draw();
      return;
    }
    if (input.matches('[data-pl-stopped]') && removal) {
      removal = { ...removal, stopped: input.value };
      draw();
      return;
    }
    if (input.closest('form[data-pl-form="name"]') && naming) {
      naming.at.typed = input.value;
      naming.at.lit = litFor(input.value);
      rested(input.value);
      drawRows();
    }
  });

  const onScroll = () => bar.classList.toggle('is-scrolled', scroll.scrollTop > 0);
  scroll.addEventListener('scroll', onScroll, { passive: true });
  const onListScroll = () => card.classList.toggle('is-scrolled', list.scrollTop > 0);
  list.addEventListener('scroll', onListScroll, { passive: true });
  /** @param {FocusEvent | PointerEvent} event */
  const emphasise = event => {
    const leaving = event.type === 'pointerout' || event.type === 'focusout';
    const at = /** @type {Element | null} */ (leaving ? event.relatedTarget : event.target);
    const row = /** @type {HTMLElement | null | undefined} */ (at?.closest?.('[data-pl-open]'));
    maps.emphasise('stage', row && list.contains(row) ? String(row.dataset.plOpen) : '');
    const circle = /** @type {HTMLElement | null | undefined} */ (at?.closest?.('[data-pl-circle]'));
    if (!circle || !list.contains(circle)) return;
    lightRow(Number(circle.dataset.plCircle));
    maps.light('stage', circleLit);
  };
  for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout']) {
    list.addEventListener(type, event => emphasise(/** @type {FocusEvent | PointerEvent} */ (event)));
  }

  const findField = () => /** @type {HTMLInputElement | null} */ ((staged() ? top : bar).querySelector('[data-pl-find]'));

  /** @param {KeyboardEvent} event */
  const onKey = event => {
    if (event.defaultPrevented || container.hidden) return;
    if (event.key === 'Escape' && panel.isOpen()) {
      event.preventDefault();
      panel.close();
      return;
    }
    if (event.key === 'Escape' && removal) {
      event.preventDefault();
      removal = null;
      draw();
      return;
    }
    if (event.key === 'Escape' && (editing || cameras)) {
      event.preventDefault();
      if (removing) actions.plKeep(root);
      else actions.plClose(root);
      draw();
      return;
    }
    if (editing && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      /** @type {HTMLFormElement | null} */ (list.querySelector('form[data-pl-form="edit"]'))?.requestSubmit();
      return;
    }
    if (namingOpen()) {
      namingKey(event);
      return;
    }
    const field = findField();
    if (!field) return;
    const active = document.activeElement;
    if (active === field) {
      if (event.key === 'Escape') field.blur();
      return;
    }
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if ((hosted && event.metaKey && event.key.toLowerCase() === 'f') || (!event.metaKey && event.key === '/')) {
      event.preventDefault();
      field.focus();
      field.select();
    }
  };
  /** @param {KeyboardEvent} event */
  function namingKey(event) {
    const at = naming?.at;
    if (!at || event.isComposing) return;
    const input = /** @type {HTMLInputElement | null} */ (list.querySelector('form[data-pl-form="name"] input[name=name]'));
    const target = event.target;
    const spot = currentSpot();
    if (target instanceof Element && target !== input && target.closest('input, textarea, select')) return;
    const command = keyCommand(event, { finish: at.ended, typed: input?.value ?? '' });
    if (!command) return;
    if (spot?.ask && !at.home.has(spot.key) && !['skip', 'undo', 'end'].includes(command)) return;
    if (command === 'type') {
      if (input && document.activeElement !== input) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }
      return;
    }
    event.preventDefault();
    if (command === 'up' || command === 'down') {
      at.lit = moved(at.lit, rowsNow().length, command === 'down' ? 1 : -1);
      drawRows();
    } else if (command === 'take') {
      if (at.lit >= 0) take(at.lit);
      else saveField();
    } else if (command === 'skip') skip();
    else if (command === 'undo') void undo();
    else if (command === 'clear' && input) {
      input.value = '';
      at.typed = '';
      at.lit = litFor('');
      rested('');
      drawRows();
    } else if (command === 'end') end();
    else if (command === 'done') leave();
  }

  document.addEventListener('keydown', onKey);

  let width = root.clientWidth;
  const resized = new ResizeObserver(() => {
    if (Math.abs(root.clientWidth - width) < 2) return;
    width = root.clientWidth;
    if (trips()) draw();
  });
  resized.observe(root);

  const FIELDS = 'form[data-pl-form] input, input[data-pl-find]';

  /**
   * @typedef {{ values: Map<string, string>, active: string, selection: [number | null, number | null] }} Typed
   * @returns {Typed}
   */
  function typedValues() {
    /** @type {Map<string, string>} */
    const values = new Map();
    for (const input of root.querySelectorAll('form[data-pl-form]:not([data-pl-form="name"]) input')) {
      const field = /** @type {HTMLInputElement} */ (input);
      values.set(fieldKey(field), field.value);
    }
    const focused = document.activeElement instanceof HTMLInputElement && root.contains(document.activeElement)
      ? document.activeElement : null;
    return { values, active: focused ? fieldKey(focused) : '',
      selection: [focused?.selectionStart ?? null, focused?.selectionEnd ?? null] };
  }

  /** @param {Typed} typedNow */
  function restore({ values, active, selection: [start, end] }) {
    for (const input of root.querySelectorAll(FIELDS)) {
      const field = /** @type {HTMLInputElement} */ (input);
      const key = fieldKey(field);
      const value = values.get(key);
      if (value !== undefined) field.value = value;
      if (key !== active || !field.getClientRects().length) continue;
      field.focus();
      if (start !== null && end !== null) field.setSelectionRange(start, end);
    }
  }

  /** @param {HTMLInputElement} field */
  const fieldKey = field => field.matches('[data-pl-find]')
    ? `find|${/** @type {HTMLElement | null} */ (field.closest('[data-part]'))?.dataset.part ?? ''}`
    : [openFocus, field.form?.dataset.plForm, field.form?.dataset.plSpot ?? '', field.name].join('|');

  onHomeChange(change => {
    if (change.clock) draw();
    const phones = kept.get('phones');
    if (phones && (change.reset || change.streams)) {
      kept.set('phones', { value: phones.value, at: -2 });
      if (staged()) draw();
    }
    if (change.reset) {
      listAt = null;
      for (const key of [...kept.keys()]) if (/^(?:place|edit|year):/u.test(key)) kept.delete(key);
    }
    const words = /** @type {{ source: string | null } | undefined} */ (kept.get('devices')?.value)?.source;
    const camerasMoved = change.reset || change.extracts.has('labels') || change.extracts.has('photos')
      || (words !== null && words !== undefined && change.imports.has(words));
    if (camerasMoved) cameraChanges += 1;
    if (camerasMoved && cameras) draw();
    void readMoves().then(() => {
      if (!pageMoved('places', change, places?.position)) return;
      changes += 1;
      void readPlaces();
      const slug = placeOpen();
      if (slug && photos?.slug === slug) photos.pages.again();
      if (trips() || slug) draw();
    });
  }, container);
  void readMoves();
  void readPlaces();
  draw();

  return {
    update() {
      if (panel.isOpen() && opener?.place !== context.route.focus) panel.close();
      draw();
    },
  };
}

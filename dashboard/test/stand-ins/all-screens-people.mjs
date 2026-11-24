// @ts-check

const hexOf = (/** @type {string} */ hash) => hash.replace('sha256:', '');
const D = 'person:person-d';
const E = 'person:person-e';
const F = 'person:person-f';
const GROUP = 'whatsapp:120363000000000099@g.us';
const enc = encodeURIComponent;

/** @param {any} shared */
export async function peopleScreens({ bases, ago, FULL_DAY }) {
  const read = async (/** @type {string} */ path) => (await fetch(`${bases.full}${path}`)).json();
  const list = await read('/api/life/people');
  const report = await read('/api/page/connectors');
  const full = async (/** @type {string} */ id) => (await read(`/api/life/people?id=${enc(id)}`)).person ?? await read(`/api/life/people?id=${enc(id)}`);
  const photos = await read(`/api/life/people/photos?id=${enc(D)}`);
  const hexes = list.people.slice(0, 30).filter((/** @type {any} */ each) => each.photo?.card).map((/** @type {any} */ each) => hexOf(each.photo.card));
  const scenes = photos.photos.map((/** @type {any} */ each) => each.image);
  const byId = (/** @type {string} */ id) => list.people.find((/** @type {any} */ each) => each.id === id);
  const facesFrom = (/** @type {number} */ seed, /** @type {number} */ many) => Array.from({ length: many }, (_, at) => `${hexes[(seed + at) % hexes.length]}:100,100,${300 + at},300`);
  const cropsOf = (/** @type {string[]} */ faces) => Object.fromEntries(faces.map(face => [face, `sha256:${face.slice(0, 64)}`]));
  const channel = (/** @type {number} */ messages) => [{ network: 'whatsapp', messages }];
  const offer = (/** @type {string} */ id, /** @type {string} */ name, /** @type {number} */ seed, /** @type {string} */ reason, more = {}) => ({ key: id, target: { kind: 'person', id }, name, face: facesFrom(seed, 1)[0], channels: channel(212 - seed), messages: 212 - seed, reason, ...more });
  const nameCard = (/** @type {string} */ id, /** @type {number} */ seed, /** @type {number} */ many, /** @type {number} */ pictures, /** @type {any[]} */ suggestions, sure = false, years = [2021, 2026]) => {
    const sample = facesFrom(seed, Math.min(12, many));
    return { id, faces: many, photos: pictures, years, year_count: years[1] - years[0] + 1, sample, suggestions, sure };
  };
  const cards = [
    nameCard('g-you', 0, 212, 164, [{ ...offer('person:me', 'You', 8, 'The most photos, and it looks like you'), me: true }], true),
    nameCard('g-sure', 1, 95, 71, [offer(D, 'Person D', 1, 'Often in photos around your messages'), offer(E, 'Person E', 2, 'In photos on days you talked')], true),
    nameCard('g-unsure', 2, 44, 30, [offer(E, 'Person E', 2, 'In photos on days you talked'), offer(F, 'Person F', 3, 'Named Person F in Google Photos'), offer('person:person-g', 'Person G', 4, 'Met in Climbing Tuesdays')]),
    nameCard('g-none', 3, 18, 12, []),
    nameCard('g-three', 4, 3, 3, [offer('person:person-h', 'Person H', 5, 'In photos on days you talked')], false, [2025, 2025]),
    nameCard('g-one', 5, 1, 1, [], false, [2024, 2024]),
  ];
  const checkFaces = facesFrom(1, 36);
  const check = { id: 'check-d-1', faces: 36, photos: 36, years: [2022, 2026], year_count: 5, sample: checkFaces, suggestions: [], sure: false,
    check: { person: { key: D, id: D, name: 'Person D', face: facesFrom(1, 1)[0], photo: byId(D).photo }, screen: 1, screens: 3, waiting: 96 } };
  const someone = list.people.slice(0, 18).map((/** @type {any} */ each, /** @type {number} */ at) => ({ id: each.id, name: each.name, origin: 'whatsapp', messages: each.score, channels: channel(each.score), target: { kind: 'person', id: each.id }, named: at < 6 ? 20 - at : 0 }));
  const allFaces = cards.flatMap(card => card.sample).concat(checkFaces);
  const deck = { ready: true, building: false, progress: { read: 100, total: 100 }, error: null, took_ms: 900, position: '0:0', people_position: '0:0', owner: null,
    cards, checks: [check], maybe: { people: 2, faces: 140, by: { [D]: 96, [E]: 44 } }, someone, crops: cropsOf(allFaces) };
  const groupRead = { ...cards[1], every: facesFrom(1, 95), crops: cropsOf(facesFrom(1, 95)), times: {} };
  const likely = { groups: [{ id: 'g-sure', faces: 95, photos: 71, years: [2021, 2026], sample: cards[1].sample.slice(0, 6), reason: 'Often in photos around your messages', crops: cropsOf(cards[1].sample) }] };

  const quiet = (/** @type {string} */ key, /** @type {string} */ label, /** @type {string} */ why, /** @type {string | null} */ last, /** @type {boolean | null} */ word = null) => ({ chat: key.split(':')[1], first_ms: ago(500), group: true, key, label, last_ms: ago(40), mine: 3, network: 'whatsapp', total: 900, quiet: { why, last_day: last }, word });
  const organised = { queue: [E, F, 'person:person-g', 'person:person-h', 'person:person-i'], organised: 42, often: 118 };
  const richList = { ...list, organise: organised, others: 12,
    people: [...list.people.map((/** @type {any} */ each, /** @type {number} */ at) => at < 3 ? each : each),
      { ...byId('person:person-al'), id: 'person:ai-a', person: 'ai-a', name: 'Claude', entity: 'ai', photo: null, handles: [{ id: 'email:assistant@example.com', kind: 'email', network: null, words: 'assistant@example.com', from: null }] },
      { ...byId('person:person-al'), id: 'person:ai-b', person: 'ai-b', name: 'ChatGPT', entity: 'ai', photo: null, handles: [{ id: 'email:chat@example.com', kind: 'email', network: null, words: 'chat@example.com', from: null }] }],
    chats: [...list.chats,
      { chat: '120363000000000098@g.us', first_ms: ago(300), group: true, key: 'whatsapp:120363000000000098@g.us', label: 'Flat 3B', last_ms: ago(2), mine: 41, network: 'whatsapp', total: 610, quiet: null, word: null },
      { chat: '120363000000000097@g.us', first_ms: ago(200), group: true, key: 'whatsapp:120363000000000097@g.us', label: 'Sunday river walk', last_ms: ago(9), mine: 8, network: 'whatsapp', total: 95, quiet: null, word: false },
      quiet('whatsapp:120363000000000096@g.us', 'Neighbourhood notices', 'silent', '2026-03-04'),
      quiet('whatsapp:120363000000000095@g.us', 'Old office', 'archived', '2025-11-20'),
      quiet('whatsapp:120363000000000094@g.us', 'Parents of class 4', 'owner', '2026-08-01', true),
      quiet('whatsapp:120363000000000093@g.us', 'Announcements', 'silent', null)] };

  const d = await full(D);
  const rich = { ...d, full_name: 'Person Delta Example', call_name: 'Person D', relationship: 'Climbing partner', organised: true, by: 'record',
    details: { work: 'Printmaker at Salt Gallery', birthday: { month: 11, day: 19, year: 1991 }, profiles: [{ network: 'instagram', value: 'person.d' }, { network: 'site', value: 'person-d.example.com' }] },
    handles: [{ id: 'phone:+15550000014', kind: 'phone', network: null, words: '+1 555 000 0014', from: 'Contacts' }, { id: 'jid:15550000014@s.whatsapp.net', kind: 'jid', network: null, words: '+1 555 000 0014', from: 'WhatsApp' }, { id: 'email:person-d@example.com', kind: 'email', network: null, words: 'person-d@example.com', from: 'You added' }],
    names_seen: ['Person D', 'P. Delta', 'Delta'],
    suggestions: [
      { id: 's-mail', kind: 'handle', value: 'email:person.delta@example.net', reasons: { mail: 6, signed: 1 }, ticked: true },
      { id: 's-phone', kind: 'handle', value: 'phone:+15550000099', reasons: { cards: 1 } },
      { id: 's-same', kind: 'same', value: 'person-k', reasons: { names: 1, photos: 4 } },
      { id: 's-gh', kind: 'profile', value: 'github:person-d', reasons: { cards: 1 } }] };
  const QUIET_DAYS = { '2021-03-14': 420, '2021-08-02': 910, '2022-05-10': 1260, '2023-01-20': 310, '2024-06-11': 44, [FULL_DAY]: 2 };
  const e = await full(E);
  const fresh = { ...e, organised: false, by: 'provider', person: null, relationship: null, full_name: null,
    handles: [{ id: 'phone:+15550000015', kind: 'phone', network: null, words: '+1 555 000 0015', from: null }], names_seen: ['Person E', 'Pers. E'],
    suggestions: [
      { id: 'e-full', kind: 'full_name', value: 'Person Echo Example', reasons: { whatsapp: 1, mail: 4 }, ticked: true },
      { id: 'e-full2', kind: 'full_name', value: 'P. E. Example', reasons: { mail: 2 } },
      { id: 'e-work', kind: 'work', value: 'Lab technician', reasons: { cards: 1 }, ticked: true },
      { id: 'e-born', kind: 'birthday', value: '03-14', reasons: { wished: 3 } },
      { id: 'e-mail', kind: 'handle', value: 'email:person-e@example.com', reasons: { mail: 12, signed: 1 }, ticked: true },
      { id: 'e-same', kind: 'same', value: 'person-l', reasons: { names: 1 } },
      { id: 'e-ig', kind: 'profile', value: 'instagram:person.e', reasons: { cards: 1 } }] };
  const suspect = { ...(await full(F)), organised: false, by: 'push-name', person: null, suggestions: [{ id: 'f-ai', kind: 'entity', value: 'business', reasons: { whatsapp: 2, named: 1 }, ticked: false }] };
  const blank = { ...(await full('person:person-h')), organised: false, by: 'none', person: null, name: '+15550000018', photo: null, suggestions: [] };

  const faceRow = (/** @type {any} */ row) => ({ ...report, connectors: report.connectors.map((/** @type {any} */ each) => each.id === 'faces' ? { ...each, ...row } : each) });
  const health = (/** @type {string} */ state, /** @type {string} */ words, acts = /** @type {any[]} */ ([])) => ({ state, reason: null, words, since_ms: null, next_ms: null, acts, detail: null });
  const facesOff = faceRow({ line: 'Off', set_up: true, on: false, health: health('off', 'Off') });
  const facesNever = faceRow({ line: 'Not turned on yet', set_up: false, on: false, health: health('setup', 'Not turned on yet') });
  const facesInstalling = faceRow({ line: 'Getting the face models', set_up: true, on: true, health: health('waiting', 'Getting the face models') });
  const facesScanning = faceRow({ line: '4,210 of 22,700 photos', set_up: true, on: true, health: health('syncing', 'Finding faces') });
  const facesPower = faceRow({ line: 'Waiting for power', set_up: true, on: true, health: health('waiting', 'Waiting for power', [{ do: 'try', label: 'Scan now', need: 'label:face-engine' }]) });
  const facesOn = faceRow({ line: 'Up to date', set_up: true, on: true, health: health('ok', 'Up to date') });

  const photoPage = (/** @type {number} */ many) => ({ position: '0:0', total: many, ...many > 16 ? { next: 'page-2' } : {}, photos: Array.from({ length: Math.min(many, 16) }, (_, at) => ({ image: scenes[at % scenes.length],
    face: `${scenes[at % scenes.length]}:104,30,168,104`, box: [104, 30, 168, 104], at_ms: ago(at * 9), crop: `sha256:${hexes[at % hexes.length]}`, camera: true })) });
  const thin = { ...byId('person:person-al'), photo: null, days: {}, days_count: 0, last_30: 0, last_ms: null, first_ms: null, received: 0, sent: 0, score: 0, chats: [], networks: [], card: true, names_seen: ['Person AL'], suggestions: [], record: null };
  const base = [
    { url: 'api/life/people$', json: richList }, { url: 'api/life/people/photos', json: photoPage(6) },
    { url: `api/life/people\\?id=${enc('person:person-al')}$`, json: { person: thin } },
    ...await Promise.all(['person:person-k', 'person:person-l'].map(async id => ({ url: `api/life/people\\?id=${enc(id)}$`, json: { person: { ...await full(id), days: { [FULL_DAY]: 2 } } } }))), { url: 'api/page/connectors', json: facesOn },
    { url: `api/life/people\\?id=${enc(D)}$`, json: { person: rich } }, { url: `api/life/people\\?id=${enc(E)}$`, json: { person: fresh } },
    { url: `api/life/people\\?id=${enc(F)}$`, json: { person: suspect } },
    { url: `api/life/people\\?id=${enc('person:person-h')}$`, json: { person: blank } },
    { url: 'api/faces/likely', json: likely }, { url: 'api/faces/group', json: groupRead }, { url: 'api/faces$', json: deck },
    { url: 'api/owner/act', method: 'POST', json: { act: 'act-1', id: E, position: '0:0' } },
  ];
  const P = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ hash, more = {}) => ({ section: 'People', name, title, hash, stub: base, ...more });
  const FA = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ hash, more = {}) => ({ section: 'Faces', name, title, hash, stub: base, ...more });
  const person = (/** @type {string} */ id) => `#view=people&focus=${enc(id)}`;
  const organise = '#view=people&focus=organise';
  const openOrganise = `await S.until('.pp-hero__name');await S.sleep(500);`;
  const openEdit = `await S.click('[data-people-edit]'); await S.until('.pp-hero__name'); await S.sleep(600);`;
  const lit = (/** @type {string} */ row) => `${openOrganise} await S.click('[data-row="${row}"]'); await S.sleep(700);`;
  const litEdit = (/** @type {string} */ row) => `${openEdit} await S.click('[data-row="${row}"]'); await S.sleep(700);`;
  const stubbed = (/** @type {any[]} */ first) => [...first, ...base];
  const emptyList = { ...list, people: [], chats: [], organise: { queue: [], organised: 0, often: 0 }, others: 0 };
  const groupHash = person(`chat:${GROUP}`);
  const faces = '#view=people&focus=faces';
  const onCard = (/** @type {number} */ skips) => `await S.until('[data-f-card]'); for (let at = 0; at < ${skips}; at += 1) { await S.click('[data-f-skip]'); await S.sleep(350); }`;
  return [
    P('people-list', 'People, the list with everyone', '#view=people'),
    P('people-scrolled', 'People, the list scrolled under its head', '#view=people', { run: `await S.scroll('.pp .ck-page__scroll', 400);` }),
    P('people-organise-tidy', 'People, list side card with people new this week', '#view=people', { stub: stubbed([{ url: 'api/life/people$', json: { ...richList, people: richList.people.map((/** @type {any} */ each, /** @type {number} */ at) => at === 1 || at === 2 ? { ...each, first_ms: ago(2) } : each) } }]) }),
    P('people-ai', 'People, AI view', '#view=people&seg=ai'),
    P('people-groups', 'People, Groups view', '#view=people&seg=groups'),
    P('people-groups-quiet', 'People, Groups view with quiet groups opened', '#view=people&seg=groups', { run: `await S.click('[data-people-quiet]');` }),
    P('people-search', 'People, list search with results', '#view=people', { run: `await S.type('[data-people-find]', 'Person A');` }),
    P('people-search-none', 'People, list search with nobody found', '#view=people', { stub: stubbed([{ url: 'api/life/people\\?q=', json: { people: [], profiles: [] } }]), run: `await S.type('[data-people-find]', 'Nobody by this name');` }),
    P('people-empty', 'People, nobody yet', '#view=people', { stub: stubbed([{ url: 'api/life/people$', json: emptyList }]) }),
    P('people-reading', 'People, loading', '#view=people', { stub: [{ url: 'api/life/people$', hold: true }], raw: true, run: `await S.sleep(2600);`, whole: false }),
    P('people-failed', 'People, list could not be read', '#view=people', { stub: [{ url: 'api/life/people$', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }] }),
    P('person-rich', 'Person, a page with everything filled in', person(D)),
    P('person-quiet', 'Person, quiet lately with years behind: the chart in years', person(D), { stub: stubbed([{ url: `api/life/people\\?id=${enc(D)}$`, json: { person: { ...rich, days: QUIET_DAYS, first_ms: Date.parse('2021-03-14T09:00:00Z') } } }]) }),
    P('person-handful', 'Person, a handful of messages: no chart, two facts', person(D), { stub: stubbed([{ url: `api/life/people\\?id=${enc(D)}$`, json: { person: { ...rich, days: { '2026-06-02': 2, [FULL_DAY]: 3 }, first_ms: Date.parse('2026-06-02T09:00:00Z') } } }]) }),
    P('person-scrolled', 'Person, scrolled to the photos', person(D), { run: `await S.scroll('.pp .ck-page__scroll', 620);` }),
    P('person-thin', 'Person, only a contact card: no messages or photos', person('person:person-al'), { stub: stubbed([{ url: 'api/life/people/photos', json: photoPage(0) }]) }),
    P('person-birthday-soon', 'Person, birthday in days on the head', person(D), { stub: stubbed([{ url: `api/life/people\\?id=${enc(D)}$`, json: { person: { ...rich, details: { ...rich.details, birthday: { month: 11, day: 12, year: 1991 } } } } }]) }),
    P('person-reading', 'Person, loading', person(D), { stub: stubbed([{ url: `api/life/people\\?id=`, hold: true }, { url: 'api/life/people/photos', hold: true }]), raw: true, run: `await S.sleep(2600);`, whole: false }),
    P('person-gone', 'Person, no longer in your messages', person('person:nobody')),
    P('person-photos-many', 'Person, many photos with pages', person(D), { stub: stubbed([{ url: 'api/life/people/photos', json: photoPage(44) }]), run: `await S.scroll('.pp .ck-page__scroll', 620);` }),
    P('person-photo-sizes', 'Person, photo size menu open', person(D), { stub: stubbed([{ url: 'api/life/people/photos', json: photoPage(44) }]), run: `await S.scroll('.pp .ck-page__scroll', 620); const menu = document.querySelector('[data-people-photos-size] button'); if (!menu) throw new Error('skip: no menu'); menu.click(); await S.sleep(400);`, optional: true }),
    P('person-talk-open', 'Person, last conversation open in the moment panel', person(D), { run: `await S.click('[data-people-open]'); await S.until('.ck-inspector__body'); await S.sleep(800);` }),
    P('person-photo-open', 'Person, a photo open in the viewer', person(D), { run: `await S.click('[data-people-photo]'); await S.until('.ck-viewer, .pv, [class*=viewer]'); await S.sleep(900); await S.awake();` }),
    P('group-page', 'Group, its page', groupHash),
    P('group-quiet', 'Group, one you are quiet in', person('chat:whatsapp:120363000000000094@g.us')),
    P('group-silent', 'Group, quiet by silence, with its word menu open', person('chat:whatsapp:120363000000000096@g.us'), { run: `await S.click('[data-people-word] .ck-fmenu__btn');` }),
    P('group-reading', 'Group, loading', groupHash, { stub: stubbed([{ url: 'api/life/conversation', hold: true }, { url: 'api/life/day\\?', hold: true }]), raw: true, run: `await S.sleep(2600);`, whole: false }),
    P('organise-first', 'Organise, first card with every suggestion', organise, { run: openOrganise }),
    P('organise-name', 'Organise, Name lit: where the name was seen', organise, { run: `${openOrganise} await S.click('[data-o-field="name"]'); await S.sleep(600);` }),
    P('organise-full', 'Organise, Full name lit: the other spellings', organise, { run: `${openOrganise} await S.click('[data-o-field="full"]'); await S.sleep(600);` }),
    P('organise-relationship', 'Organise, Relationship lit, typed', organise, { run: `${openOrganise} await S.type('[data-o-field="rel"]', 'Lab friend'); await S.sleep(500);` }),
    P('organise-work', 'Organise, Work lit: where it was found', organise, { run: `${openOrganise} await S.click('[data-o-field="work"]'); await S.sleep(600);` }),
    P('organise-guess', 'Organise, a birthday the home guesses, lit', organise, { run: lit('o:e-born') }),
    P('organise-calendar', 'Organise, Add birthday: the calendar', organise, { run: `${openOrganise} await S.click('[data-o-do="addbirthday"]'); await S.sleep(600);` }),
    P('organise-notperson', 'Organise, Not a person? menu', organise, { run: `${openOrganise} await S.click('[data-o-do="notperson"]'); await S.sleep(600);` }),
    P('organise-handle', 'Organise, a number of theirs lit', organise, { run: lit('h:phone:+15550000015') }),
    P('organise-email', 'Organise, an email suggestion lit: its mails', organise, { run: lit('o:e-mail') }),
    P('organise-same', 'Organise, Same person? lit: the other person', organise, { run: lit('o:e-same') }),
    P('organise-profile', 'Organise, a profile suggestion lit', organise, { run: lit('o:e-ig') }),
    P('organise-group', 'Organise, a face group the deck offers, lit', organise, { run: lit('g:g-sure') }),
    P('organise-add', 'Organise, the add field with what it finds', organise, { run: `${openOrganise} await S.type('[data-o-add]', 'Person'); await S.sleep(900);` }),
    P('organise-add-profile', 'Organise, the add field reads a pasted link', organise, { stub: stubbed([{ url: 'api/life/people\\?q=', json: { people: [], profiles: [{ network: 'instagram', value: 'person.e.prints' }] } }]), run: `${openOrganise} await S.type('[data-o-add]', 'https://instagram.com/person.e.prints'); await S.sleep(900);` }),
    P('organise-photo', 'Organise, Choose their photo', organise, { run: `${openOrganise} await S.click('[data-o-do="photo"]'); await S.until('[data-o-chooser]'); await S.sleep(900);` }),
    P('organise-move-scale', 'Organise, Move and scale a photo', organise, { run: `${openOrganise} await S.click('[data-o-do="photo"]'); await S.click('[data-o-frame]'); await S.sleep(1200);` }),
    P('organise-mark-face', 'Organise, Mark their face browser', organise, { stub: stubbed([{ url: 'api/life/people$', json: { ...richList, organise: { ...organised, queue: ['person:person-h'] } } }]), run: `${openOrganise} await S.click('[data-o-do="faces"]'); await S.sleep(900);` }),
    P('organise-suspected', 'Organise, the home suspects a business', organise, { stub: stubbed([{ url: 'api/life/people$', json: { ...richList, organise: { ...organised, queue: [F] } } }]), run: openOrganise }),
    P('organise-suspected-lit', 'Organise, the suspicion lit: its signs', organise, { stub: stubbed([{ url: 'api/life/people$', json: { ...richList, organise: { ...organised, queue: [F] } } }]), run: lit('o:f-ai') }),
    P('organise-nameless', 'Organise, someone known only by a number', organise, { stub: stubbed([{ url: 'api/life/people$', json: { ...richList, organise: { ...organised, queue: ['person:person-h'] } } }]), run: openOrganise }),
    P('organise-refused', 'Organise, Confirm refused by the home', organise, { stub: stubbed([{ url: 'api/owner/act', method: 'POST', status: 409, json: { error: 'Lifestream is starting up. Try again in a moment.', code: 'NOT_NOW' } }]), run: `${openOrganise} await S.click('[data-o-do="confirm"]'); await S.sleep(900);` }),
    P('organise-confirmed', 'Organise, next card with Undo in the foot', organise, { run: `${openOrganise} await S.click('[data-o-do="confirm"]'); await S.sleep(900);` }),
    P('organise-end', 'Organise, the end of a sitting', organise, { stub: stubbed([{ url: 'api/life/people$', json: { ...richList, organise: { ...organised, queue: [E] } } }]), run: `${openOrganise} await S.click('[data-o-do="confirm"]'); await S.sleep(1000);` }),
    P('organise-end-skipped', 'Organise, the end with people skipped', organise, { stub: stubbed([{ url: 'api/life/people$', json: { ...richList, organise: { ...organised, queue: [E] } } }]), run: `${openOrganise} await S.click('[data-o-do="skip"]'); await S.sleep(1000);` }),
    P('organise-reading', 'Organise, loading a card', organise, { stub: stubbed([{ url: 'api/life/people\\?id=', hold: true }]), raw: true, run: `await S.sleep(2000);`, whole: false }),
    P('edit-person', 'Edit person, everything filled in', person(D), { run: openEdit }),
    P('edit-bottom', 'Edit person, scrolled to its last card', person(D), { run: `${openEdit} const box = [...document.querySelectorAll('.pl-card *')].find(each => each.scrollHeight > each.clientHeight + 4 && getComputedStyle(each).overflowY !== 'visible'); if (box) box.scrollTop = box.scrollHeight; await S.sleep(500);` }),
    P('edit-sparse', 'Edit person, someone known by little', person('person:person-k'), { run: openEdit }),
    P('edit-name', 'Edit person, Name lit', person(D), { run: `${openEdit} await S.click('[data-o-field="name"]'); await S.sleep(600);` }),
    P('edit-renamed', 'Edit person, name being changed', person(D), { run: `${openEdit} await S.type('[data-o-field="name"]', 'Delta'); await S.sleep(500);` }),
    P('edit-birthday', 'Edit person, Birthday calendar open', person(D), { run: `${openEdit} await S.click('[data-row="f:birthday"]'); await S.sleep(700);` }),
    P('edit-handle', 'Edit person, their email lit', person(D), { run: litEdit('h:email:person-d@example.com') }),
    P('edit-profile', 'Edit person, a profile of theirs lit', person(D), { run: litEdit('p:instagram:person.d') }),
    P('edit-merge', 'Edit person, merge: Same person? lit and ticked', person(D), { run: `${litEdit('o:s-same')} await S.click('[data-o-tick="o:s-same"]');` }),
    P('edit-photo', 'Edit person, Choose their photo with pages', person(D), { stub: stubbed([{ url: 'api/life/people/photos', json: photoPage(44) }]), run: `${openEdit} await S.click('[data-o-do="photo"]'); await S.until('[data-o-chooser]'); await S.sleep(900);` }),
    P('edit-remove', 'Edit person, a number removed', person(D), { run: `${openEdit} await S.click('[data-o-remove="phone:+15550000014"]'); await S.sleep(500);` }),
    P('edit-more-faces', 'Edit person, Find more photos of them pressed', person(D), { run: `${openEdit} (await S.until('[data-o-do="more"]')).scrollIntoView({ block: 'center' }); await S.sleep(300); await S.click('[data-o-do="more"]'); await S.sleep(900);` }),
    P('edit-save-refused', 'Edit person, Save refused by the home', person(D), { stub: stubbed([{ url: 'api/owner/act', method: 'POST', status: 409, json: { error: 'Lifestream is starting up. Try again in a moment.', code: 'NOT_NOW' } }]), run: `${openEdit} await S.type('[data-o-field="rel"]', 'Friend'); await S.click('[data-o-do="save"]'); await S.sleep(900);` }),
    FA('faces-settings-on', 'Faces, dialog: on and up to date', `#view=people&dialog=faces`),
    FA('faces-turn-on-row', 'Faces, turned off: Turn on faces on People', '#view=people', { stub: stubbed([{ url: 'api/page/connectors', json: facesNever }]) }),
    FA('faces-never-dialog', 'Faces, turning on: the dialog before it is set up', '#view=people&dialog=faces', { stub: stubbed([{ url: 'api/page/connectors', json: facesNever }]) }),
    FA('faces-off-dialog', 'Faces, dialog: switched off', '#view=people&dialog=faces', { stub: stubbed([{ url: 'api/page/connectors', json: facesOff }]) }),
    FA('faces-installing-dialog', 'Faces, dialog: getting the face models', '#view=people&dialog=faces', { stub: stubbed([{ url: 'api/page/connectors', json: facesInstalling }]) }),
    FA('faces-scanning-dialog', 'Faces, dialog: scanning photos', '#view=people&dialog=faces', { stub: stubbed([{ url: 'api/page/connectors', json: facesScanning }]) }),
    FA('faces-power-dialog', 'Faces, dialog: waiting for power, Scan now', '#view=people&dialog=faces', { stub: stubbed([{ url: 'api/page/connectors', json: facesPower }]) }),
    FA('faces-none-yet', 'Faces, page before any scan: No faces yet', faces, { stub: stubbed([{ url: 'api/faces$', status: 500, json: { error: 'Lifestream has no faces yet.' } }, { url: 'api/page/connectors', json: facesNever }]) }),
    FA('faces-reading-start', 'Faces, reading: before it knows how much', faces, { stub: stubbed([{ url: 'api/faces$', json: { ready: false, building: true, progress: { read: 0, total: 0 }, error: null, took_ms: null } }]), raw: true, run: `await S.sleep(1500);`, whole: false }),
    FA('faces-reading', 'Faces, scanning: the reading meter', faces, { stub: stubbed([{ url: 'api/faces$', json: { ready: false, building: true, progress: { read: 4210, total: 22700 }, error: null, took_ms: null } }]), raw: true, run: `await S.sleep(2600);`, whole: false }),
    FA('faces-side-reading', 'Faces, People’s side card while faces are read', '#view=people', { stub: stubbed([{ url: 'api/faces$', json: { ready: false, building: true, progress: { read: 4210, total: 22700 }, error: null, took_ms: null } }]) }),
    FA('faces-failed', 'Faces, faces could not be read', faces, { stub: stubbed([{ url: 'api/faces$', status: 500, json: { error: 'Lifestream is starting: it answers in a moment.' } }]) }),
    FA('faces-you', 'Faces, first card: is this you?', faces, { run: `await S.until('[data-f-card]');` }),
    FA('faces-sure', 'Faces, an unnamed group the home is sure of', faces, { run: onCard(1) }),
    FA('faces-unsure', 'Faces, an unnamed group with three suggestions', faces, { run: onCard(2) }),
    FA('faces-no-suggestion', 'Faces, a group with nothing to suggest', faces, { run: onCard(3) }),
    FA('faces-typing', 'Faces, naming a group: people found as typed', faces, { run: `${onCard(2)} await S.type('#face-name', 'Person'); await S.sleep(500);` }),
    FA('faces-new-person', 'Faces, naming a group: New person', faces, { run: `${onCard(2)} await S.type('#face-name', 'Someone New'); await S.sleep(500);` }),
    FA('faces-marked-out', 'Faces, faces pressed out of a group', faces, { run: `${onCard(1)} for (const face of [...document.querySelectorAll('[data-f-face]')].slice(2, 5)) { face.click(); await S.sleep(120); }` }),
    FA('faces-show-all', 'Faces, Show all faces of a group', faces, { run: `${onCard(1)} await S.click('[data-f-all]'); await S.sleep(1200);` }),
    FA('faces-answered', 'Faces, the next card after naming, Back and what it did', faces, { run: `${onCard(1)} await S.click('[data-f-row="0"]'); await S.sleep(900);` }),
    FA('faces-set-aside', 'Faces, a group set aside', faces, { run: `${onCard(2)} const rows = document.querySelectorAll('[data-f-row]'); rows[rows.length - 1].click(); await S.sleep(900);` }),
    FA('faces-save-failed', 'Faces, a save the home refused', faces, { stub: stubbed([{ url: 'api/owner/act', method: 'POST', status: 409, json: { error: 'Lifestream is starting up.', code: 'NOT_NOW' } }]), run: `${onCard(1)} await S.click('[data-f-row="0"]'); await S.sleep(1200);` }),
    FA('faces-checkpoint', 'Faces, the checkpoint before the smaller groups', faces, { run: `${onCard(4)}` }),
    FA('faces-small', 'Faces, a group of three faces', faces, { run: `${onCard(4)} await S.click('[data-f-keep]'); await S.sleep(600);` }),
    FA('faces-single', 'Faces, a group of one face', faces, { run: `${onCard(4)} await S.click('[data-f-keep]'); await S.sleep(400); await S.click('[data-f-skip]'); await S.sleep(600);` }),
    FA('faces-may-be', 'Faces, “may be X” review: Is this Person D?', faces, { stub: stubbed([{ url: 'api/faces$', json: { ...deck, cards: [] } }]), run: `await S.until('[data-f-card]');` }),
    FA('faces-may-be-marked', 'Faces, may be X with faces pressed out', faces, { stub: stubbed([{ url: 'api/faces$', json: { ...deck, cards: [] } }]), run: `await S.until('[data-f-card]'); for (const face of [...document.querySelectorAll('[data-f-face]')].slice(3, 9)) { face.click(); await S.sleep(100); }` }),
    FA('faces-may-be-photo', 'Faces, may be X: a face’s whole photo', faces, { stub: stubbed([{ url: 'api/faces$', json: { ...deck, cards: [] } }]), run: `await S.until('[data-f-card]'); const face = await S.until('[data-f-face]'); face.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await S.sleep(1500);` }),
    FA('faces-finish', 'Faces, the finish: who was named', faces, { stub: stubbed([{ url: 'api/faces$', json: { ...deck, cards: cards.slice(1, 2), checks: [] } }]), run: `await S.until('[data-f-card]'); await S.click('[data-f-row="0"]'); await S.sleep(900);` }),
    FA('faces-finish-skipped', 'Faces, the finish with groups skipped', faces, { stub: stubbed([{ url: 'api/faces$', json: { ...deck, cards: cards.slice(1, 2), checks: [] } }]), run: `await S.until('[data-f-card]'); await S.click('[data-f-skip]'); await S.sleep(900);` }),
    FA('faces-all-named', 'Faces, everyone named', faces, { stub: stubbed([{ url: 'api/faces$', json: { ...deck, cards: [], checks: [], maybe: { people: 0, faces: 0, by: {} } } }]) }),
    FA('faces-one-person', 'Faces, on one person from Edit', `#view=people&focus=faces&on=${enc(D)}`, { stub: stubbed([{ url: 'api/faces$', json: deck }]), run: `await S.until('[data-f-card]');` }),
  ];
}

// @ts-check
/** @import { DayMoment, MomentApp, MomentFact, MomentSite, MomentTimed, MomentView, ScreenAccount } from '../../pages.js' */
import { attributes, esc } from '../../lib/html.js';
import { itemSent } from '../../lib/sent.js';
import { readHost } from '../../lib/host.js';
import { dayAt } from '../../lib/home-clock.js';
import { wordsOr } from '../../lib/reach.js';
import { capital, clock, clockSeconds, counted, duration, range, shortDay } from '../../lib/words.js';
import {
  ARRIVES, inPlaceLine, facts, figureStrip, files, gallery, icon, installFilterMenus, items, linked, made,
  madeActs, meter, monogram, pageLack, prose, reading, sectionLabel, sentLine, tag, thread, threadReading, TRANSCRIBE,
  voiceLine,
} from '../kit/index.js';
import { replyMarkdown } from '../markdown.js';
import { messagesOf, transcribedOf } from './messages.js';

/**
 * @typedef {{ slug: string, name: string, latitude: number, longitude: number, radius_m: number, stays: number, days: number, hours: number, first_ms: number | null, last_ms: number | null }} Place
 * @typedef {{ places: Place[] }} PlacesAnswer
 * @typedef {{ slug: string | null, name: string | null, latitude: number, longitude: number }} Spot
 * @typedef {{ place?: Spot | null, from?: Spot | null, to?: Spot | null }} Placed
 * @typedef {{ text: { title?: string, text: string, who?: string[], link?: string } | null, blobs?: string[], transcribed?: import('../../types.js').Made | null }} RecordAnswer
 */

/** @typedef {{ places: () => Promise<PlacesAnswer>, placed: (unit: string) => Promise<Placed>, record: (ref: { source: string, kind: string, key: string }) => Promise<RecordAnswer>, conversation: (chat: string, day: string) => Promise<import('../../lib/api.js').ChatDay>, thread: (chat: string, day: string) => Promise<import('../../pages.js').Thread> }} Reads */

/** @typedef {{ terms?: string[], only?: number | null }} Opened */

/** @param {string} text */
const label = text => `<div class="dy-v__label">${sectionLabel(text, { level: 3 })}</div>`;

/** @param {number | null} ms */
const at = ms => ms === null ? '' : clock(ms);

/** @param {MomentTimed} line */
const span = line => line.start_ms === null ? '' : range(line.start_ms, line.end_ms);

/** @param {{ at: string, text: string, icon?: string }[]} lines */
const timedItems = lines => lines.length ? items(lines.map(line => ({ title: line.text, at: line.at, icon: line.icon ?? 'time' })),
  { small: true }) : '';

/** @param {MomentFact[]} list */
const factsOf = list => facts(list.map(each => /** @type {[string, string]} */ ([each.label, each.value])));

/** @param {MomentApp[]} apps */
function minuteMeters(apps) {
  const timed = apps.flatMap(app => app.minutes === null ? [] : [{ name: app.name, minutes: app.minutes }]);
  if (!timed.length) return '';
  const most = Math.max(1, ...timed.map(app => app.minutes));
  const meters = timed.map(app => meter(app.name, app.minutes === 0.5 ? '<1m' : duration(app.minutes * 60000),
    app.minutes / most));
  return `<div class="dy-meters">${meters.join('')}</div>`;
}

/** @param {MomentSite} site */
const siteItem = site => ({ title: site.title, line: site.line ?? undefined, at: at(site.at_ms), icon: site.icon, href: site.href ?? undefined });

/**
 * @param {DayMoment} moment
 * @param {Opened} opened
 */
export function viewerOf(moment, opened) {
  const view = moment.view;
  switch (view.view) {
    case 'thread': return `<div class="dy-v__thread"${attributes({ 'data-d-fill': 'thread', 'data-d-chat': view.chat })}>${threadReading()}</div>`;
    case 'quiet': return `<div class="dy-v__thread"${attributes({ 'data-d-fill': 'quiet', 'data-d-chat': view.chat })}>${threadReading()}</div>`;
    case 'ai': return aiViewer(view);
    case 'call': return callViewer(view);
    case 'mail': return mailViewer(view, opened.only ?? null);
    case 'stay': return stayViewer(view);
    case 'move': return moveViewer(view);
    case 'body': return bodyViewer(view);
    case 'sitting': return sittingViewer(view);
    case 'apps': return figureStrip(view.total_ms === null ? [] : [{ value: duration(view.total_ms), label: 'Screen Time says' }])
      + minuteMeters(view.apps) + (view.sites.length ? items(view.sites.map(siteItem), { small: true }) : '');
    case 'event': return eventViewer(view, moment.start_ms);
    case 'note': return view.words ? writing(view.words) : '<p class="dy-quiet mac-body">The note’s line holds no words beyond its title.</p>';
    case 'voice': return voiceViewer(view);
    case 'photos': return (moment.pictures.length ? gallery(moment.pictures) : '')
      + timedItems(view.lines.map(line => ({ at: at(line.start_ms), text: line.text, icon: line.video ? 'video' : 'photo' })));
    case 'listening': return items(view.tracks.map(track => ({ title: track, icon: 'music' })), { small: true });
    case 'check_in': return checkInViewer(view);
    case 'payment': return figureStrip(view.amount === null ? [] : [{ value: view.amount, label: view.direction === 'in' ? 'In' : 'Out' }])
      + factsOf(view.facts);
    case 'lines': return timedItems(view.lines.map(line => ({ at: at(line.start_ms), text: line.text })));
  }
}

/** @param {Extract<MomentView, { view: 'ai' }>} view */
function aiViewer(view) {
  const work = view.work.map(words => `<p class="ck-ai__steps mac-subhead">${icon('ai', { size: 'xs' })}<span>${esc(words)}</span></p>`).join('');
  const drawn = view.turns.map(turn => {
    const extra = (turn.files.length ? files(turn.files.map(name => ({ name }))) : '')
      + (turn.tools.length ? `<p class="ck-ai__steps mac-subhead">${icon('ai', { size: 'xs' })}<span>Used ${esc(turn.tools.join(', '))}</span></p>` : '');
    const marked = turn.marked ? ' is-marked' : '';
    if (turn.mine) return `<p class="ck-ai__turn mac-body${marked}"${attributes({ title: at(turn.at_ms) })}>${esc(turn.words)}</p>${extra}`;
    if (!turn.full) return `<div class="ck-ai__reply${marked}">${prose(turn.words)}</div>`;
    const long = turn.words.length > REPLY_SHOWN;
    return `<div class="ck-ai__reply${marked}${long ? ' is-long' : ''}"><div class="ck-prose">${replyMarkdown(turn.words)}</div>${extra}`
      + (long ? '<button type="button" class="ck-fold mac-footnote" data-ck-more aria-label="Show all">•••</button>' : '') + '</div>';
  }).join('');
  return `<div class="ck-ai">${work}${drawn}</div>`;
}

/** @param {Extract<MomentView, { view: 'call' }>} view */
function callViewer(view) {
  const figure = view.figure
    ? [{ value: view.figure.length_ms === null ? view.figure.words ?? '' : duration(view.figure.length_ms), label: view.figure.label }] : [];
  const others = view.others.map(other => ({ at: clock(other.at_ms), text: [other.way, other.length_ms === null ? '' : duration(other.length_ms)]
    .filter(Boolean).join(' · '), icon: 'call' }));
  return figureStrip(figure) + facts([['In', view.group]])
    + (others.length ? `<div data-d-fill="calls">${label(`Other calls with ${view.name} today`)}${timedItems(others)}</div>` : '');
}

/** @param {Extract<MomentView, { view: 'mail' }>['letters'][number]} mail */
function letter(mail) {
  return '<article class="ck-letter">'
    + `<div class="ck-letter__from">${monogram(mail.from || '?', 'md')}<span class="ck-letter__names">`
    + `<span class="ck-letter__name mac-headline">${esc(mail.from || 'Unknown sender')}</span>`
    + `<span class="ck-letter__addr mac-subhead">${esc(mail.address ?? '')}</span></span>`
    + (mail.to ? `<span class="ck-letter__to mac-subhead">To ${esc(mail.to)}</span>` : '') + '</div>'
    + `<div class="ck-letter__words">${mail.words ? prose(mail.words) : ''}</div>`
    + (mail.attached.length ? label(counted(mail.attached.length, 'attachment')) + files(mail.attached.map(name => ({ name }))) : '')
    + '</article>';
}

/**
 * @param {Extract<MomentView, { view: 'mail' }>} view
 * @param {number | null} only
 */
function mailViewer(view, only) {
  const alone = only === null ? undefined : view.letters[only];
  if (alone) return letter(alone);
  if (!view.list) return letter(view.letters[0]);
  return items(view.letters.map((mail, index) => ({ face: mail.from || '?', title: mail.subject || '(no subject)',
    line: [mail.from, mail.words].filter(Boolean).join(' — '), at: at(mail.at_ms), attrs: { 'data-d-mail': index } })));
}

/** @param {Extract<MomentView, { view: 'stay' }>} view */
function stayViewer(view) {
  const inside = view.inside.map(line => ({ at: span(line), text: line.text, icon: 'walk' }));
  return `<div data-d-fill="stay-figures" data-d-unit="${esc(view.unit)}" data-d-today="${esc(duration(view.today_ms))}">`
    + `${figureStrip([{ value: duration(view.today_ms), label: 'Here today' }])}</div>`
    + (view.note ? `<p class="dy-v__note mac-subhead">${esc(view.note)}</p>` : '')
    + (inside.length ? label('Inside the stay') + timedItems(inside) : '');
}

/** @param {Extract<MomentView, { view: 'move' }>} view */
function moveViewer(view) {
  const legs = view.legs.map(line => ({ at: span(line), text: line.text, icon: 'move' }));
  const figures = [...(view.km ? [{ value: view.km, label: 'Distance' }] : []),
    ...(view.length_ms === null ? [] : [{ value: duration(view.length_ms), label: 'Duration' }])];
  return figureStrip(figures)
    + facts([['From', view.from], ['To', view.to], ['Mode', view.mode ?? '']])
    + (legs.length ? label(counted(legs.length, 'leg')) + timedItems(legs) : '')
    + (view.note ? `<p class="dy-v__note mac-subhead">${esc(view.note)}</p>` : '');
}

/** @param {Extract<MomentView, { view: 'body' }>} view */
function bodyViewer(view) {
  const figures = view.length_ms ? [{ value: duration(view.length_ms), label: view.label }] : [];
  if (view.bed_ms !== null && view.wake_ms !== null) figures.push({ value: clock(view.bed_ms), label: 'Bed' }, { value: clock(view.wake_ms), label: 'Wake' });
  const paras = view.vitals.map(words => `<p class="dy-v__para mac-body">${esc(words)}</p>`).join('');
  return figureStrip(figures) + view.facts.map(factsOf).join('') + (view.vitals.length ? label('The day’s vitals') + paras : '');
}

/** @param {Extract<MomentView, { view: 'sitting' }>} view */
function sittingViewer(view) {
  const appMeters = minuteMeters(view.apps) ? label('Apps') + minuteMeters(view.apps) : '';
  const siteLines = view.sites.length ? label('Sites') + items(view.sites.map(siteItem), { small: true }) : '';
  const account = view.account;
  if (!account) {
    const lines = view.lines.map(line => ({ at: at(line.start_ms), text: line.text, icon: 'screen' }));
    return appMeters + label('What the screen shows') + timedItems(lines) + siteLines;
  }
  const longest = Math.max(1, ...account.tasks.map(task => task.seconds));
  return (account.narrative ? prose(account.narrative) : '')
    + (account.tasks.length ? label('Time per task') + `<div class="dy-meters">${account.tasks.map(task =>
      meter(task.task, duration(task.seconds * 1000), task.seconds / longest)).join('')}</div>` : '')
    + appMeters + siteLines
    + names('People', account.people) + names('Projects', account.projects)
    + steps(account);
}

/**
 * @param {string} title
 * @param {string[]} entries
 */
const names = (title, entries) => entries.length ? label(title) + `<p class="dy-tags">${entries.map(name => tag(name)).join('')}</p>` : '';

/** @param {ScreenAccount} account */
function steps(account) {
  if (!account.steps.length && !account.loose.length) return '';
  /** @param {{ at_ms: number, what: string }[]} list */
  const did = list => list.length ? `<ol class="dy-steps__actions">${list.map(action => '<li>'
    + `<span class="mac-mono-time">${esc(clockSeconds(action.at_ms))}</span>`
    + `<span class="mac-subhead">${esc(action.what)}</span></li>`).join('')}</ol>` : '';
  const away = /** @type {Record<string, string>} */ ({ no: 'Away', unsure: 'Unsure if there' });
  const list = account.steps.map(step => `<li class="dy-steps__step${step.present === 'no' ? ' is-away' : ''}">`
    + `<p class="dy-steps__when"><span class="mac-mono-time">${esc(clock(step.start_ms))}</span>`
    + `<span class="mac-mono-data">${esc(duration(step.end_ms - step.start_ms))}</span>`
    + (step.present ? tag(away[step.present] ?? step.present) : '') + '</p>'
    + (step.task ? `<p class="mac-headline">${esc(step.task)}</p>` : '')
    + (step.where ? `<p class="mac-subhead dy-quiet">${esc(step.where)}</p>` : '')
    + (step.doing ? `<p class="mac-body">${esc(step.doing)}</p>` : '')
    + did(step.actions) + '</li>').join('');
  const count = [account.steps.length ? counted(account.steps.length, 'step') : '', account.actions ? counted(account.actions, 'action') : '']
    .filter(Boolean).join(' · ');
  return '<details class="dy-steps"><summary class="dy-steps__summary">'
    + '<span class="mac-mono-label">Step by step</span>'
    + `<span class="mac-mono-data">${esc(count)}</span>`
    + `${icon('expand', { size: 'xs', className: 'dy-steps__chevron' })}</summary>`
    + `<ol class="dy-steps__list">${list}</ol>${did(account.loose)}</details>`;
}

/**
 * @param {Extract<MomentView, { view: 'event' }>} view
 * @param {number | null} start
 */
function eventViewer(view, start) {
  const ahead = view.plan && start !== null ? Math.max(0, start - Date.now()) : null;
  const soon = ahead === null ? '' : tag(`Coming up · in ${duration(ahead)}`, { tone: 'plan' });
  return (soon ? `<p class="dy-v__plan">${soon}</p>` : '')
    + `<div>${facts([['Where', view.where ?? ''], ['With', view.with ?? '']])}${view.words ? prose(view.words) : ''}</div>`;
}

/** @param {string} words */
function writing(words) {
  const todo = /^\s*[-*] \[([ xX])\] ?(.*)$/u;
  const listed = /^\s*(?:[-*•]|\d+[.)])\s/u;
  /** @param {string} line */
  const entry = line => {
    const box = todo.exec(line);
    if (!box) return `<li>${linked(line.replace(listed, ''))}</li>`;
    const done = box[1] !== ' ';
    return `<li class="dy-todo${done ? ' is-done' : ''}">${icon(done ? 'todo-done' : 'todo', { size: 'sm' })}<span>${linked(box[2])}</span></li>`;
  };
  const blocks = words.trim().split(/\n\s*\n/u).flatMap(block => {
    /** @type {string[][]} */
    const runs = [];
    for (const line of block.split('\n')) {
      const last = runs.at(-1);
      if (last && listed.test(last[0]) === listed.test(line)) last.push(line);
      else runs.push([line]);
    }
    return runs.map(lines => {
      if (!listed.test(lines[0])) return `<p>${linked(lines.join('\n'))}</p>`;
      const tag = /^\s*\d+[.)]\s/u.test(lines[0]) ? 'ol' : 'ul';
      return `<${tag}${lines.some(line => todo.test(line)) ? ' class="dy-todos"' : ''}>${lines.map(entry).join('')}</${tag}>`;
    });
  });
  return `<div class="ck-prose dy-writing">${blocks.join('')}</div>`;
}

/** @param {Extract<MomentView, { view: 'voice' }>} view */
function voiceViewer(view) {
  return view.notes.map((note, index) => {
    const fill = note.record ? { 'data-d-fill': 'voice', 'data-d-n': index, 'data-d-seconds': note.seconds } : {};
    return `<div class="dy-v__memo">${view.timed ? `<p class="dy-v__memo-at mac-mono-time">${esc(at(note.at_ms))}</p>` : ''}`
      + `<div${attributes(fill)}>${voiceLine({ audio: null, seconds: note.seconds, words: '' })}</div>`
      + (note.words ? `<blockquote class="dy-voice mac-voice-l">“${esc(note.words)}”</blockquote>` : '') + '</div>';
  }).join('');
}

/** @param {Extract<MomentView, { view: 'check_in' }>} view */
function checkInViewer(view) {
  if (view.head === null) {
    return figureStrip([...(view.median ? [{ value: view.median, label: 'Median' }] : []),
      ...(view.lapses ? [{ value: view.lapses, label: 'Lapses' }] : [])]) + factsOf(view.facts);
  }
  return `<p class="dy-v__note mac-subhead">${esc(view.head)}</p>` + factsOf(view.facts)
    + (view.note ? `<blockquote class="dy-voice mac-voice">“${esc(view.note)}”</blockquote>` : '');
}

/** @type {import('../kit/made.js').MadeActs | null} */
let transcribing = null;
const transcribingNow = () => transcribing ??= madeActs(readHost(window));

/**
 * @param {HTMLElement} holder
 * @param {object} parts
 * @param {() => import('../../types.js').Made[]} parts.made
 * @param {() => Promise<void>} parts.read
 * @param {() => void} parts.draw
 * @param {() => boolean} parts.current
 */
function followTranscripts(holder, { made: madeOf, read, draw, current }) {
  const followed = transcribingNow().follow({ made: madeOf, read, draw, live: () => current() && holder.isConnected });
  /** @param {string} item @param {string} route */
  const transcribe = (item, route) => {
    const ask = madeOf().find(each => each.ask?.item === item)?.ask;
    if (ask && route) void followed.choose(ask, route);
  };
  holder.addEventListener('click', event => {
    const pressed = /** @type {Element} */ (event.target).closest('button[data-ck-transcribe]');
    if (pressed instanceof HTMLElement) transcribe(pressed.dataset.ckTranscribe ?? '', pressed.dataset.value ?? '');
  });
  installFilterMenus(holder, (menu, route) => {
    if (menu.dataset.ckTranscribe !== undefined) transcribe(menu.dataset.ckTranscribe, route);
  });
}

/**
 * @param {() => boolean} current
 * @param {() => void} draw
 * @returns {(messages: import('../kit/thread.js').Message[]) => import('../kit/thread.js').Message[]}
 */
function notesWent(current, draw) {
  /** @type {Map<string, { words: string, href: string } | null>} */
  const went = new Map();
  return messages => messages.map(message => {
    const ask = message.voice?.transcribed?.state === 'done' ? message.voice.transcribed.ask : null;
    if (!ask || !message.voice) return message;
    const key = `${ask.family}\0${ask.item}`;
    if (!went.has(key)) {
      went.set(key, null);
      void itemSent(ask).then(sent => {
        if (!sent || !current()) return;
        went.set(key, sent);
        draw();
      });
    }
    const sent = went.get(key);
    return sent ? { ...message, voice: { ...message.voice, sent } } : message;
  });
}

/**
 * @param {Reads} reads
 * @param {string} chat
 * @param {string} day
 */
async function threadOn(reads, chat, day) {
  const thread = await reads.thread(chat, day);
  const voiced = thread.messages.some(message => message.voice);
  const made = voiced ? await reads.conversation(chat, day).then(transcribedOf, () => new Map()) : new Map();
  return { thread, made };
}

/** @param {import('../kit/thread.js').Message[]} messages */
const transcribedIn = messages => messages.flatMap(message => message.voice?.transcribed ? [message.voice.transcribed] : []);

const REPLY_SHOWN = 1600;

/**
 * @param {import('../../pages.js').Thread} thread
 * @param {readonly string[]} keys
 */
const marksIn = (thread, keys) => thread.messages.flatMap((message, n) => keys.includes(message.key) ? [n] : []);

/**
 * @param {HTMLElement} root
 * @param {string} day
 * @param {DayMoment} moment
 * @param {Reads} reads
 * @param {() => boolean} current
 * @param {Opened} opened
 * @param {string} owner
 */
export async function fillViewer(root, day, moment, reads, current, opened, owner) {
  const group = moment.view.view === 'thread' && moment.view.group;
  const threadHolder = /** @type {HTMLElement | null} */ (root.querySelector('[data-d-fill="thread"]'));
  if (threadHolder) {
    reading(threadHolder, true);
    const chat = threadHolder.dataset.dChat ?? '';
    const read = () => chat ? threadOn(reads, chat, day).catch(() => null) : Promise.resolve(null);
    let said = await read();
    if (!current()) return;
    reading(threadHolder, false);
    const messagesNow = () => said ? messagesOf(said.thread, said.made) : [];
    const drawThread = () => {
      threadHolder.innerHTML = thread(went(messagesNow()), { group,
        marks: said ? marksIn(said.thread, moment.marks) : [], terms: opened.terms ?? [], transcripts: transcribingNow(), owner });
    };
    const went = notesWent(current, drawThread);
    drawThread();
    followTranscripts(threadHolder, { made: () => transcribedIn(messagesNow()), current, draw: drawThread, read: async () => {
      const again = await read();
      if (again) said = again;
    } });
    threadHolder.firstElementChild?.classList.add(ARRIVES);
    const marked = threadHolder.querySelector('.ck-msg.is-marked');
    marked?.scrollIntoView({ block: 'center' });
  }

  const quiet = /** @type {HTMLElement | null} */ (root.querySelector('[data-d-fill="quiet"]'));
  if (quiet) {
    reading(quiet, true);
    const read = async () => {
      const said = await threadOn(reads, String(quiet.dataset.dChat), day);
      return messagesOf(said.thread, said.made);
    };
    /** @type {import('../kit/thread.js').Message[] | null} */
    let messages = null;
    let failed = '';
    try {
      messages = await read();
    } catch (error) {
      failed = wordsOr(error, 'This conversation couldn’t be read.');
    }
    if (!current()) return;
    reading(quiet, false);
    const drawQuiet = () => {
      quiet.innerHTML = messages ? thread(went(messages), { group: true, terms: opened.terms ?? [], transcripts: transcribingNow(), owner })
        : pageLack(failed);
    };
    const went = notesWent(current, drawQuiet);
    drawQuiet();
    if (messages) {
      followTranscripts(quiet, { made: () => transcribedIn(messages ?? []), current, draw: drawQuiet, read: async () => {
        messages = await read();
      } });
    }
    quiet.firstElementChild?.classList.add(ARRIVES);
  }

  const ai = root.querySelector('.ck-ai .is-marked');
  ai?.scrollIntoView({ block: 'center' });

  const notes = moment.view.view === 'voice' ? moment.view.notes : [];
  for (const holder of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-d-fill="voice"]'))) {
    const ref = notes[Number(holder.dataset.dN)]?.record;
    if (!ref) continue;
    const record = () => reads.record(ref);
    void record().then(found => {
      if (!current()) return;
      const seconds = holder.dataset.dSeconds;
      let answer = found;
      /** @type {{ words: string, href: string } | null} */
      let sent = null;
      const ask = found.transcribed?.ask;
      if (ask) {
        void itemSent(ask).then(went => {
          if (!went || !current()) return;
          sent = went;
          drawVoice();
        });
      }
      const drawVoice = () => {
        const blob = answer.blobs?.[0];
        const transcribed = answer.transcribed ?? null;
        holder.innerHTML = voiceLine({ audio: blob ?? null, seconds: seconds ? Number(seconds) : null, words: '' }, { owner })
          + made({ made: transcribed, verbs: TRANSCRIBE, acts: transcribingNow().hosted && Boolean(transcribed?.ask),
            busy: transcribingNow().busy(transcribed), id: transcribed?.ask?.item ?? `voice-${holder.dataset.dN}`,
            attrs: { 'data-ck-transcribe': transcribed?.ask?.item ?? '' } })
          + (transcribingNow().refused(transcribed) ? inPlaceLine(transcribingNow().refused(transcribed)) : '')
          + sentLine(sent);
      };
      drawVoice();
      followTranscripts(holder, { made: () => answer.transcribed ? [answer.transcribed] : [], current, draw: drawVoice,
        read: async () => {
          answer = await record();
        } });
    }, () => undefined);
  }

  const figures = /** @type {HTMLElement | null} */ (root.querySelector('[data-d-fill="stay-figures"]'));
  if (!figures) return;
  let answer;
  let placed;
  try {
    [answer, placed] = await Promise.all([reads.places(), reads.placed(String(figures.dataset.dUnit))]);
  } catch {
    return;
  }
  const place = placed.place ? answer.places.find(each => each.slug === placed.place?.slug) ?? null : null;
  if (!current() || !place) return;
  const first = place.first_ms === null ? '' : dayAt(place.first_ms).day;
  figures.innerHTML = figureStrip([{ value: String(figures.dataset.dToday), label: 'Here today' },
    { value: place.stays.toLocaleString('en-US'), label: 'Visits' },
    ...(first ? [{ value: shortDay(first, day.slice(0, 4)), label: 'First visit' }] : [])]);
}

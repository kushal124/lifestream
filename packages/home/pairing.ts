import { randomBytes, randomInt } from "node:crypto";
import { declarations, vendorOf, type Connector } from "@lifestreamprotocol/connect";
import { isObject, type HomeFolder, type JsonObject, type OpenView, type Tx } from "@lifestreamprotocol/core";
import { deviceName, nameDevice, nameKey, phoneUnits } from "./devices.js";
import { failpoint } from "./failpoint.js";
import { DEVICE_KINDS, DEVICES, homeSources, isDeviceKind, laneOf, offered, pairedAccount, unitId, unitSources, type Delivered, type DeviceKind } from "./devices.js";
import { deviceOf, mintPrincipal, passOf, readPrincipals, retireUnit, stateAccount, widen, type Principal } from "./principals.js";
import { CLI } from "./cli-name.js";
import { KNOCK_MS, KNOCKS } from "./knocks.js";


export const CODE_MS = 10 * 60_000;
export const SHOWN_MS = 10_000;
export const TYPED_MS = 2 * 60_000;
export const CODE_GUESSES = 5;
const DIGITS = 8;
const PASS = /^[A-Za-z0-9_-]{43}$/u;
export const SERIAL4 = /^[0-9a-f]{4}$/u;
const DRAWS = 16;
export const ASKED_MS = 10_000;
const ASKING = 4;
export interface PairRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly phones?: readonly Phone[];
}

export type Redeemed =
  | { readonly unit: string; readonly pass: string }
  | { readonly pending: string }
  | { readonly refused: PairRefusal };

export interface ConnectRequest {
  readonly id: string;
  readonly browser: string;
}

export interface Connecting {
  readonly requests: readonly ConnectRequest[];
}

export interface Link {
  readonly link: string | null;
  readonly why: string | null;
}

interface Asking extends ConnectRequest {
  readonly at_ms: number;
  readonly pass: string;
  readonly unit: string;
  seen_ms: number;
  every_ms: number;
}

interface Knock {
  readonly first_ms: number;
  last_ms: number;
  stated_last_ms: number;
  pass: string;
  unit: string;
}

interface Code {
  readonly unit: string | null;
  readonly expires_ms: number;
  guesses: number;
}

interface Lease {
  readonly code: string;
  readonly expires_ms: number;
  asked_ms: number;
  link: Promise<Link>;
  built: Link | null;
}

export interface PairingHome {
  readonly folder: HomeFolder;
  readonly home: string;
  commit<T>(work: (tx: Tx) => T): T;
  view(): OpenView;
  now(): number;
  readonly connectors: readonly Connector[];
}

const refused = (status: number, code: string, message: string): Redeemed => ({ refused: { status, code, message } });
const WRONG = refused(403, "PAIR_CODE", "this code does not pair: it is unknown, used, expired, or ended by wrong guesses");
const TAKEN_BACK = refused(403, "CONNECT_TAKEN_BACK", "Lifestream on this Mac doesn't know this browser now: remove the extension and add it again.");

export class Pairing {
  readonly #codes = new Map<string, Code>();
  readonly #used = new Map<string, { readonly unit: string; readonly expires_ms: number }>();
  #leased: Lease | null = null;
  #wait: { asked_ms: number; until_ms: number } | null = null;
  readonly #asking = new Map<string, Asking>();
  readonly #denied = new Set<string>();
  readonly #ended = new Map<string, number>();
  readonly #knocks = new Map<string, Knock>();

  constructor(private readonly home: PairingHome, private readonly random: (bytes: number) => Buffer = randomBytes) {}

  get #principals(): HomeFolder {
    return this.home.folder;
  }

  mint(unit: string | null): { code: string; unit: string | null; expires_ms: number } {
    if (unit !== null && !this.#known(unit)) throw new Error(`no device ${unit}: a code replaces a unit Lifestream holds`);
    this.#prune();
    return this.#mint(unit);
  }

  #mint(unit: string | null): { code: string; unit: string | null; expires_ms: number } {
    let code: string;
    do code = String(randomInt(10 ** DIGITS)).padStart(DIGITS, "0"); while (this.#codes.has(code) || this.#used.has(code));
    const expires_ms = this.home.now() + CODE_MS;
    this.#codes.set(code, { unit, expires_ms, guesses: 0 });
    return { code, unit, expires_ms };
  }

  async show(build: (code: string) => Promise<Link>): Promise<{ code: string; expires_ms: number } & Link> {
    const now = this.home.now();
    this.#prune();
    this.#lapse(now);
    let lease = this.#leased;
    if (lease === null) {
      const { code, expires_ms } = this.#mint(null);
      lease = this.#leased = this.#kept({ code, expires_ms, asked_ms: now, link: build(code), built: null });
    } else if (lease.built?.link === null) {
      lease.built = null;
      lease.link = build(lease.code);
      this.#kept(lease);
    }
    lease.asked_ms = now;
    return { code: lease.code, expires_ms: lease.expires_ms, ...await lease.link };
  }

  #kept(lease: Lease): Lease {
    const settle = (made: Link) => {
      if (this.#leased === lease && this.#codes.has(lease.code)) lease.built = made;
    };
    void lease.link.then(settle, () => settle({ link: null, why: null }));
    return lease;
  }

  state(code: string): { state: "live" } | { state: "used"; unit: string } | { state: "gone" } {
    this.#prune();
    this.#lapse(this.home.now());
    if (this.#codes.has(code)) return { state: "live" };
    const used = this.#used.get(code);
    return used === undefined ? { state: "gone" } : { state: "used", unit: used.unit };
  }

  redeem(body: unknown, browser: string | null = null): Redeemed {
    this.#lapse(this.home.now());
    const request = readRequest(body, browser);
    if ("refused" in request) return request;
    const known = passOf(this.#principals, request.pass);
    if (known !== undefined) {
      if (request.code === null && known.kind === request.kind && (known.revoked_at !== null || known.suspended_at !== null)) return TAKEN_BACK;
      if (known.revoked_at !== null || known.suspended_at !== null || known.kind !== request.kind) return WRONG;
      this.#ensure(known, request.offers, request.model);
      this.#name(known.unit, request.name, false);
      return { unit: known.unit, pass: known.id };
    }
    if (request.code === null) return this.#ask(request);
    this.#prune();
    const code = this.#codes.get(request.code);
    if (code === undefined) {
      for (const [text, live] of this.#codes) if (++live.guesses >= CODE_GUESSES) this.#codes.delete(text);
      return WRONG;
    }
    const unit = code.unit ?? this.#unitFor(request);
    if (typeof unit !== "string") return unit;
    this.#codes.delete(request.code);
    this.#used.set(request.code, { unit, expires_ms: code.expires_ms });
    return this.#pair(unit, request);
  }

  #lapse(now: number): void {
    const lease = this.#leased;
    if (lease !== null && (!this.#codes.has(lease.code) || now - lease.asked_ms > SHOWN_MS)) {
      this.#codes.delete(lease.code);
      this.#leased = null;
    }
    const wait = this.#wait;
    if (wait === null || now <= wait.until_ms) return;
    this.#wait = null;
    for (const pass of this.#denied) this.#ended.set(pass, now);
    for (const [pass, asking] of this.#asking) if (asking.at_ms <= wait.asked_ms) this.#ended.set(pass, now);
    this.#asking.clear();
    this.#denied.clear();
  }

  prune(): void {
    const now = this.home.now();
    this.#lapse(now);
    for (const [pass, last_ms] of this.#ended) if (now - last_ms > KNOCK_MS) this.#ended.delete(pass);
    const gone = [...this.#knocks].filter(([, knock]) => now - knock.last_ms > KNOCK_MS);
    if (gone.length === 0) return;
    for (const [browser] of gone) this.#knocks.delete(browser);
    this.#stateKnocks();
  }

  connecting(lease_ms = SHOWN_MS): Connecting {
    const now = this.home.now();
    this.#lapse(now);
    const opening = this.#wait === null;
    this.#wait = { asked_ms: now, until_ms: Math.max(this.#wait?.until_ms ?? 0, now + lease_ms) };
    if (opening) {
      this.#ended.clear();
      this.#offered(now);
    }
    this.#pruneAsking();
    return { requests: [...this.#asking.values()].sort((a, b) => a.at_ms - b.at_ms).map(({ id, browser }) => ({ id, browser })) };
  }

  answer(id: string, allow: boolean): { readonly answered: { readonly id: string; readonly unit: string; readonly allowed: boolean } } {
    this.#lapse(this.home.now());
    this.#pruneAsking();
    const asking = [...this.#asking.values()].find((each) => each.id === id);
    if (this.#wait === null || asking === undefined) throw new Error(`no request ${id} waits: it was answered, its browser stopped asking, or the Browser step stopped waiting`);
    if (allow && this.#retired(asking.unit)) throw new Error(`${asking.unit} was removed from Lifestream, and a removed browser does not connect again`);
    if (allow && this.#taken(asking.unit)) throw new Error(`Lifestream holds ${asking.unit} already: that browser connects again once it is removed`);
    this.#asking.delete(asking.pass);
    if (!allow) this.#denied.add(asking.pass);
    else this.#pair(asking.unit, { kind: "extension", pass: asking.pass, model: asking.browser, offers: [] });
    return { answered: { id, unit: asking.unit, allowed: allow } };
  }

  #ask(request: PairRequest): Redeemed {
    if (this.#wait === null) {
      const now = this.home.now();
      const ended = this.#ended.get(request.pass);
      if (ended !== undefined && now - ended <= KNOCK_MS) this.#ended.set(request.pass, now);
      else {
        this.#ended.delete(request.pass);
        this.#knock(request.model, request.pass, request.unit!);
      }
      return refused(409, "NOT_WAITING", "Open Lifestream on your Mac to allow it.");
    }
    if (this.#denied.has(request.pass)) return refused(403, "CONNECT_DENIED", "Lifestream on this Mac said not now.");
    this.#pruneAsking();
    const now = this.home.now();
    const asked = this.#asking.get(request.pass);
    if (asked !== undefined) {
      asked.seen_ms = now;
      asked.every_ms = ASKED_MS;
      return { pending: asked.id };
    }
    if (this.#retired(request.unit!)) return refused(409, "PAIR_UNIT_RETIRED", "This browser was removed from Lifestream, and a removed browser does not connect again.");
    if (this.#taken(request.unit!)) return refused(409, "PAIR_UNIT_EXISTS", "Lifestream on this Mac knows this browser already: remove it there, then connect again.");
    if (this.#asking.size >= ASKING) return refused(429, "CONNECT_CROWDED", "Other browsers are asking to connect: answer them in Lifestream on this Mac first.");
    const id = this.#requestId();
    this.#asking.set(request.pass, { id, browser: request.model, at_ms: now, pass: request.pass, unit: request.unit!, seen_ms: now, every_ms: ASKED_MS });
    return { pending: id };
  }

  #requestId(): string {
    let id: string;
    do id = `c-${this.random(4).toString("hex")}`; while ([...this.#asking.values()].some((each) => each.id === id));
    return id;
  }

  #offered(now: number): void {
    if (this.#knocks.size === 0) return;
    for (const [browser, knock] of [...this.#knocks].sort(([, a], [, b]) => a.first_ms - b.first_ms)) {
      if (now - knock.last_ms > KNOCK_MS || this.#asking.has(knock.pass) || this.#asking.size >= ASKING || this.#retired(knock.unit) || this.#taken(knock.unit)) continue;
      this.#asking.set(knock.pass, { id: this.#requestId(), browser, at_ms: now, pass: knock.pass, unit: knock.unit, seen_ms: knock.last_ms, every_ms: KNOCK_MS });
    }
    this.#knocks.clear();
    this.#stateKnocks();
  }

  #knock(browser: string, pass: string, unit: string): void {
    const now = this.home.now();
    const kept = this.#knocks.get(browser);
    if (kept !== undefined) {
      kept.last_ms = now;
      kept.pass = pass;
      kept.unit = unit;
      if (now - kept.stated_last_ms >= KNOCK_MS / 4) this.#stateKnocks();
      return;
    }
    this.#knocks.set(browser, { first_ms: now, last_ms: now, stated_last_ms: now, pass, unit });
    this.#stateKnocks();
  }

  #stateKnocks(): void {
    const standing = Object.fromEntries([...this.#knocks].map(([browser, knock]) => {
      knock.stated_last_ms = knock.last_ms;
      return [browser, { first_ms: knock.first_ms, last_ms: knock.last_ms }];
    }));
    this.home.commit((tx) => (this.#knocks.size === 0 ? tx.tables.meta.delete(KNOCKS) : tx.tables.meta.set(KNOCKS, JSON.stringify(standing))));
  }

  #pair(unit: string, request: Pick<PairRequest, "kind" | "pass" | "model" | "offers" | "account" | "name">): Redeemed {
    const lane = laneOf(request.kind, unit);
    const account = request.account ?? null;
    const { principal } = mintPrincipal(this.#principals, {
      unit, kind: request.kind, scopes: DEVICES[request.kind].scopes, sources: [...(lane === null ? [] : [lane]), ...unitSources(request.kind, unit, account, this.home.home, this.home.connectors).map((source) => source.id)],
      token: request.pass, now_ms: this.home.now(), account,
    });
    const view = this.home.view();
    let retired: number | null;
    try {
      retired = view.tables.devices.get(unit)?.retired_ms ?? null;
    } finally {
      view.close();
    }
    if (retired !== null) retireUnit(this.#principals, unit, retired);
    failpoint("pair.passed");
    this.#ensure(principal, request.offers, request.model);
    this.#name(unit, request.name, true);
    return { unit, pass: principal.id };
  }

  #name(unit: string, name: string | undefined, replace: boolean): void {
    if (name === undefined) return;
    const view = this.home.view();
    let had: string | undefined;
    try {
      had = view.tables.meta.get(nameKey(unit));
    } finally {
      view.close();
    }
    if (had === name || (had !== undefined && !replace)) return;
    this.home.commit((tx) => nameDevice(tx, unit, name, this.home.now()));
  }

  offer(passId: string, offers: readonly string[]): string[] {
    const pass = readPrincipals(this.#principals).principals.find((row) => row.id === passId);
    if (pass === undefined || pass.kind === null || pass.revoked_at !== null) return [];
    const before = new Set(pass.sources);
    return this.#ensure(pass, offers).sources.filter((source) => !before.has(source));
  }

  stateAccount(passId: string, stated: unknown): { account: string; made: string[] } | { refused: PairRefusal } {
    const pass = readPrincipals(this.#principals).principals.find((row) => row.id === passId);
    if (pass === undefined || pass.kind !== "phone" || pass.revoked_at !== null) return { refused: { status: 403, code: "ACCOUNT_KIND", message: "Only a paired phone states its Apple ID." } };
    const account = typeof stated === "string" ? pairedAccount("phone", stated, this.home.connectors) : null;
    if (account === null) return { refused: { status: 422, code: "ACCOUNT_REQUEST", message: "account is the phone's Apple ID: an email address or a phone number" } };
    if (pass.account !== null && pass.account !== account) return { refused: { status: 409, code: "ACCOUNT_SET", message: `This phone's Apple ID is ${pass.account} already: pair it again to use another.` } };
    this.#ensure(pass.account === account ? pass : stateAccount(this.#principals, pass.id, account), []);
    const unnamed = new Set(unitSources("phone", pass.unit, null, this.home.home, this.home.connectors).map((source) => source.id));
    return { account, made: unitSources("phone", pass.unit, account, this.home.home, this.home.connectors).map((source) => source.id).filter((id) => !unnamed.has(id)) };
  }

  ensureAll(): void {
    const owned = homeSources(this.home.home);
    const view = this.home.view();
    let missing: Delivered[];
    try {
      missing = owned.filter((source) => view.tables.sources.get(source.id) === undefined);
    } finally {
      view.close();
    }
    if (missing.length > 0) this.home.commit((tx) => this.#add(tx, missing, null));
    for (const pass of readPrincipals(this.#principals).principals) {
      if (deviceOf(pass) !== null && pass.revoked_at === null) this.#ensure(pass, []);
    }
  }

  #ensure(pass: Principal, offers: readonly string[], model?: string): Principal {
    const kind = deviceOf(pass)!;
    const made: Delivered[] = [
      ...unitSources(kind, pass.unit, pass.account, this.home.home, this.home.connectors),
      ...offers.flatMap((id) => offered(kind, pass.unit, id, this.home.connectors) ?? []),
    ];
    const view = this.home.view();
    let whole: boolean;
    try {
      whole = made.every((source) => view.tables.sources.get(source.id) !== undefined) && (model === undefined || view.tables.devices.get(pass.unit)?.model === model);
    } finally {
      view.close();
    }
    if (!whole) this.home.commit((tx) => {
      const device = model === undefined ? undefined : tx.tables.devices.get(pass.unit);
      if (model !== undefined && device === undefined) {
        tx.tables.devices.add({ unit: pass.unit, model, added_ms: this.home.now() });
        tx.tables.events.append({ at_ms: this.home.now(), kind: "device-add", key: pass.unit, detail: { model } });
      } else if (model !== undefined && device!.model !== model) {
        tx.tables.devices.remodel(pass.unit, model);
        tx.tables.events.append({ at_ms: this.home.now(), kind: "device-model", key: pass.unit, detail: { model, was: device!.model } });
      }
      this.#add(tx, made, pass.id);
    });
    return widen(this.#principals, pass.id, DEVICES[kind].scopes, made.map((source) => source.id));
  }

  #add(tx: Tx, sources: readonly Delivered[], pass: string | null): void {
    for (const source of sources) {
      if (tx.tables.sources.get(source.id) !== undefined) continue;
      tx.tables.sources.add({ id: source.id, vendor: vendorOf(this.home.connectors, source.id), connector: source.connector, options: source.options ?? {}, added_ms: this.home.now() });
      tx.tables.events.append({ at_ms: this.home.now(), kind: "source-add", key: source.id, detail: { connector: source.connector, pass } });
    }
  }

  #unitFor(request: PairRequest): string | Extract<Redeemed, { refused: PairRefusal }> {
    const exists = (unit: string) => refused(409, "PAIR_UNIT_EXISTS", `Lifestream holds ${unit} already: replace that device with a code for its unit (${CLI} pair --replace ${unit})`) as Extract<Redeemed, { refused: PairRefusal }>;
    const free = (unit: string) => this.#retired(unit)
      ? refused(409, "PAIR_UNIT_RETIRED", `${unit} was removed from Lifestream (${CLI} device retire ${unit}), and a removed device does not pair again: its history stays in Lifestream, and it records nothing more`) as Extract<Redeemed, { refused: PairRefusal }>
      : this.#taken(unit) ? exists(unit) : unit;
    if (DEVICES[request.kind].unit !== undefined) return free(request.unit!);
    if (request.kind === "phone" && request.new !== true) {
      const phones = this.phones();
      if (request.unit !== undefined) {
        return phones.some((phone) => phone.unit === request.unit) ? request.unit
          : refused(409, "PAIR_UNIT_UNKNOWN", `Lifestream holds no phone ${request.unit} it records with: choose one it lists, or pair as another phone`) as Extract<Redeemed, { refused: PairRefusal }>;
      }
      if (phones.length > 0) {
        return { refused: { status: 409, code: "PAIR_WHICH_PHONE", message: "Lifestream holds a phone already: say which one this phone continues, or that it is another", phones } };
      }
    }
    for (let draw = 0; ; draw++) {
      const drawn = unitId(request.model, request.serial4, this.random)!;
      if (request.serial4 !== undefined) return free(drawn);
      if (!this.#known(drawn)) return drawn;
      if (draw === DRAWS) return exists(drawn);
    }
  }

  phones(): Phone[] {
    const passes = readPrincipals(this.#principals).principals.filter((row) => row.kind === "phone");
    const view = this.home.view();
    try {
      return phoneUnits(view.tables, passes).filter((phone) => !phone.retired).map((phone) => {
        const shipped = passes.filter((row) => row.unit === phone.unit).map((row) => view.tables.deliveries.sealedBy(row.id)?.newest_ms ?? null).filter((at): at is number => at !== null);
        return { unit: phone.unit, model: phone.model, account: phone.account, last_ms: shipped.length === 0 ? null : Math.max(...shipped) };
      }).sort((a, b) => (a.last_ms ?? 0) - (b.last_ms ?? 0) || a.unit.localeCompare(b.unit));
    } finally {
      view.close();
    }
  }

  #retired(unit: string): boolean {
    const view = this.home.view();
    try {
      return (view.tables.devices.get(unit)?.retired_ms ?? null) !== null;
    } finally {
      view.close();
    }
  }

  #known(unit: string): boolean {
    const view = this.home.view();
    try {
      if (view.tables.devices.get(unit) !== undefined) return true;
    } finally {
      view.close();
    }
    return readPrincipals(this.#principals).principals.some((row) => row.unit === unit);
  }

  #taken(unit: string): boolean {
    return readPrincipals(this.#principals).principals.some((row) => row.unit === unit && row.revoked_at === null);
  }

  #pruneAsking(): void {
    const now = this.home.now();
    for (const [pass, asking] of this.#asking) if (now - asking.seen_ms > asking.every_ms) this.#asking.delete(pass);
  }

  #prune(): void {
    const now = this.home.now();
    for (const [text, code] of this.#codes) if (code.expires_ms <= now) this.#codes.delete(text);
    for (const [text, used] of this.#used) if (used.expires_ms <= now) this.#used.delete(text);
  }
}

interface PairRequest {
  readonly code: string | null;
  readonly pass: string;
  readonly kind: DeviceKind;
  readonly model: string;
  readonly serial4?: string;
  readonly unit?: string;
  readonly account?: string;
  readonly new?: true;
  readonly offers: readonly string[];
  readonly name?: string;
}

export interface Phone {
  readonly unit: string;
  readonly model: string;
  readonly account: string | null;
  readonly last_ms: number | null;
}

function readRequest(body: unknown, browser: string | null): PairRequest | Extract<Redeemed, { refused: PairRefusal }> {
  const bad = (message: string) => refused(422, "PAIR_REQUEST", message) as Extract<Redeemed, { refused: PairRefusal }>;
  if (!isObject(body)) return bad("the body is a JSON object");
  const { code, pass, kind, serial4, unit, account, offers, new: another, connect, name } = body as JsonObject;
  if (connect !== undefined && (connect !== true || code !== undefined || kind !== "extension" || browser === null)) {
    return bad("connect is true, from the extension, with no code, through the door, which names its browser");
  }
  const model = connect === true ? browser : body.model;
  if (connect === undefined && (typeof code !== "string" || !new RegExp(`^\\d{${DIGITS}}$`, "u").test(code))) return bad(`code is ${DIGITS} digits`);
  if (typeof pass !== "string" || !PASS.test(pass)) return bad("pass is 32 random bytes, base64url");
  if (!isDeviceKind(kind)) return bad(`kind is one of ${DEVICE_KINDS.join(", ")}`);
  if (typeof model !== "string" || unitId(model, "0000") === null) return bad("model is the device's marketing name");
  if (serial4 !== undefined && (typeof serial4 !== "string" || !SERIAL4.test(serial4))) return bad("serial4 is four lowercase hex digits");
  if (offers !== undefined && (!Array.isArray(offers) || offers.some((offer) => typeof offer !== "string"))) return bad("offers is a list of source ids");
  const named = DEVICES[kind].unit;
  if (named === undefined && unit !== undefined && (kind !== "phone" || typeof unit !== "string" || unitId(unit, "0000") === null)) {
    return bad(kind === "phone" ? "unit is the phone this one continues" : `a ${kind} names no unit: Lifestream makes it from its model and serial`);
  }
  if (named !== undefined && (typeof unit !== "string" || !named.test(unit))) return bad(`a ${kind} names its own unit, ${named.source}`);
  if (another !== undefined && (kind !== "phone" || another !== true || unit !== undefined)) return bad("new is true, from a phone that continues no unit");
  if (account !== undefined && DEVICES[kind].account !== "paired") {
    return refused(422, "PAIR_ACCOUNT", `a ${kind} states no account at pairing: it offers each source with its own account in its exchange`) as Extract<Redeemed, { refused: PairRefusal }>;
  }
  const spelled = account === undefined ? undefined : typeof account === "string" ? pairedAccount(kind, account, declarations()) : null;
  if (spelled === null) return bad("account is the phone's Apple ID: an email address or a phone number");
  const given = typeof name === "string" ? deviceName(name) : null;
  const stated = given !== null && "name" in given ? { name: given.name } : {};
  return { code: connect === true ? null : code as string, pass, kind, model, ...(serial4 === undefined ? {} : { serial4 }), ...(typeof unit === "string" ? { unit } : {}), ...(spelled === undefined ? {} : { account: spelled }), ...(another === true ? { new: true as const } : {}), ...stated, offers: (offers ?? []) as string[] };
}

export const PEER_GUESSES = 3;
export const PEERS_KEPT = 1_024;

export type Taken = { readonly giveBack: () => void };

export class PeerGuesses {
  readonly #peers = new Map<string, { readonly at: number }[]>();

  constructor(private readonly now: () => number, private readonly limit = PEER_GUESSES, private readonly kept = PEERS_KEPT) {}

  take(peer: string): Taken | { readonly wait: number } {
    const now = this.now();
    const counted = (this.#peers.get(peer) ?? []).filter((guess) => now - guess.at < CODE_MS);
    const slowed = counted.length >= this.limit;
    const guess = { at: now };
    if (!slowed) counted.push(guess);
    this.#peers.delete(peer);
    this.#peers.set(peer, counted);
    while (this.#peers.size > this.kept) this.#peers.delete(this.#peers.keys().next().value!);
    if (slowed) return { wait: Math.max(1, Math.ceil((counted[0]!.at + CODE_MS - now) / 1_000)) };
    return {
      giveBack: () => {
        const held = this.#peers.get(peer);
        const at = held?.indexOf(guess) ?? -1;
        if (at === -1 || this.now() - guess.at >= CODE_MS) return;
        held!.splice(at, 1);
        if (held!.length === 0) this.#peers.delete(peer);
      },
    };
  }

  get size(): number {
    return this.#peers.size;
  }
}

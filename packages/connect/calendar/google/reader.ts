import { addDays, archive, basicInstant, consuming, each, fileMember, forThisAccount, ics, instant, instantOf, isObject, readJson, refuse, sourceName, span, spanOf, utf8, zipped, type Delivery, type DeliveryFile, type Guard, type Instant, type JsonObject, type Member, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const PULL_FORMAT = "org.lifestreamprotocol.google-calendar-api-pull/0.1";
export const PULL_MANIFEST = "pull.json";

const VEVENT = /^BEGIN:VEVENT(\r?\n)(?:[\s\S]*\n)?END:VEVENT\1$/u;

const event: Guard = (content) => {
  if (content === null || typeof content !== "object" || Array.isArray(content)) return ["content must be an object"];
  const keys = Object.keys(content).sort().join(",");
  if (keys !== "content,type") return ["content must hold exactly type and content"];
  const out: string[] = [];
  if (content.type !== "calendar.event") out.push("type must be calendar.event");
  if (typeof content.content !== "string" || !VEVENT.test(content.content)) out.push("content must be one VEVENT, its lines ended by CRLF or by LF");
  return out;
};


export const gcalApi: Reader = {
  name: "gcal-api",
  kinds: { event },
  async *read(delivery, files) {
    const manifestFile = fileAt(delivery, PULL_MANIFEST) ?? refuse(`an API pull holds ${PULL_MANIFEST}`);
    const manifest = pullManifest(files.bytes(manifestFile.blob));
    const account = channelAccount(delivery.source, "cloud");
    if (manifest.account !== account) refuse(`the pull states account ${JSON.stringify(manifest.account)}, not the source's ${JSON.stringify(account)}`);
    const pages = manifest.pages.map((page) => {
      const file = fileAt(delivery, page.file) ?? refuse(`the pull lists ${page.file}, which the delivery does not hold`);
      if (file.blob !== `sha256:${page.sha256}` || file.size !== page.bytes) refuse(`${page.file} does not match the hash and size the pull states`);
      return { page, file };
    });
    yield* each(pages, ({ page }) => page.file, ({ page, file }) => {
      const body = readJson(utf8(files.bytes(file.blob), page.file), page.file);
      const items = isObject(body) && Array.isArray(body.items) ? body.items : refuse(`${page.file} has no items array`);
      const uids = page.calendar === undefined ? {} : manifest.uids[page.calendar] ?? {};
      const where = (index: number) => `${page.file}:item ${index}`;
      return each(items.entries(), ([index]) => where(index), ([index, item]) => {
        if (!isObject(item)) refuse(`${where(index)} is not an object`);
        const row = apiRow(item, uids, where(index));
        return row === undefined ? [] : [row];
      });
    });
  },
};

interface PullManifest {
  account: string;
  pages: { file: string; sha256: string; bytes: number; calendar?: string }[];
  uids: Record<string, Record<string, string>>;
}

function pullManifest(bytes: Buffer): PullManifest {
  const value = readJson(utf8(bytes, PULL_MANIFEST), PULL_MANIFEST);
  if (!isObject(value)) refuse(`${PULL_MANIFEST} is not an object`);
  if (value.format !== PULL_FORMAT || value.complete !== true) refuse(`${PULL_MANIFEST} is not a complete ${PULL_FORMAT} pull`);
  if (typeof value.account !== "string" || value.account.length === 0) refuse(`${PULL_MANIFEST} states no account`);
  if (!Array.isArray(value.pages) || value.pages.length === 0) refuse(`${PULL_MANIFEST} lists no pages`);
  const seen = new Set<string>();
  const pages = value.pages.map((entry, index) => {
    if (!isObject(entry)) refuse(`${PULL_MANIFEST} page ${index} is not an object`);
    const { file, sha256, bytes: size, calendar_id: calendar } = entry;
    if (typeof file !== "string" || file.length === 0 || seen.has(file)) refuse(`${PULL_MANIFEST} page ${index} names no file, or one already listed`);
    seen.add(file);
    const hex = typeof sha256 === "string" ? sha256.replace(/^sha256:/u, "") : "";
    if (!/^[0-9a-f]{64}$/u.test(hex)) refuse(`${PULL_MANIFEST} page ${index} states no sha256`);
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) refuse(`${PULL_MANIFEST} page ${index} states no byte count`);
    if (calendar !== undefined && (typeof calendar !== "string" || calendar.length === 0)) refuse(`${PULL_MANIFEST} page ${index} states an invalid calendar_id`);
    if (calendar === undefined && value.uids !== undefined) refuse(`${PULL_MANIFEST} states uids, and page ${index} no calendar_id`);
    return { file, sha256: hex, bytes: size, ...(calendar === undefined ? {} : { calendar }) };
  });
  const uids = value.uids ?? {};
  const named = isObject(uids) && Object.values(uids).every((each) => isObject(each) && Object.values(each).every((uid) => typeof uid === "string" && uid.length > 0));
  if (!named) refuse(`${PULL_MANIFEST} uids must map each calendar's event ids to UIDs`);
  return { account: value.account, pages, uids: uids as Record<string, Record<string, string>> };
}

function apiRow(item: JsonObject, uids: Record<string, string>, where: string): ReaderOutput | undefined {
  const start = isObject(item.start) ? item.start : undefined;
  const end = isObject(item.end) ? item.end : undefined;
  if (start === undefined && end === undefined) {
    if (item.status !== "cancelled") refuse(`${where}: states neither start nor end and is no cancellation`);
    const named = typeof item.recurringEventId === "string" ? item.recurringEventId : item.id;
    const uid = typeof item.iCalUID === "string" && item.iCalUID.length > 0 ? item.iCalUID : typeof named === "string" ? uids[named] : undefined;
    if (uid === undefined) return undefined;
    return { kind: "event", key: apiKey({ ...item, iCalUID: uid }, where), content: null, gone: true, locator: where };
  }
  return { kind: "event", key: apiKey(item, where), content: { type: "calendar.event", content: vevent(item, where) }, time: apiTime(start, end, where), locator: where };
}

function apiKey(item: JsonObject, where: string): string {
  const uid = typeof item.iCalUID === "string" && item.iCalUID.length > 0 ? item.iCalUID : refuse(`${where}: states no iCalUID`);
  const occurrence = recurrence(item, where);
  return occurrence === undefined ? uid : `${uid}:${occurrenceKey(occurrence.occurrence)}`;
}

function apiTime(start: JsonObject | undefined, end: JsonObject | undefined, where: string): Instant {
  if (start === undefined || end === undefined) refuse(`${where}: states only one end of its interval`);
  if (typeof start.date === "string" || typeof end.date === "string") {
    if (typeof start.date !== "string" || typeof end.date !== "string") refuse(`${where}: start and end mix date and dateTime`);
    if (!ics.isDate(start.date) || !ics.isDate(end.date)) refuse(`${where}: an invalid date`);
    if (end.date <= start.date) refuse(`${where}: end.date must be after start.date`);
    return span(instant(start.date, "date"), instant(addDays(end.date, -1), "date"));
  }
  if (typeof start.dateTime !== "string" || typeof end.dateTime !== "string") refuse(`${where}: start and end state no date or dateTime`);
  return interval(stated(start.dateTime, `${where} start`), stated(end.dateTime, `${where} end`), where);
}

interface IcsValue {
  params: string;
  value: string;
  occurrence: string;
  form: "date" | "date-time";
}

function recurrence(item: JsonObject, where: string): IcsValue | undefined {
  const series = typeof item.recurringEventId === "string" && item.recurringEventId.length > 0;
  const original = isObject(item.originalStartTime) ? item.originalStartTime : undefined;
  if (!series && original === undefined) return undefined;
  if (!series || original === undefined) refuse(`${where}: an override needs recurringEventId and originalStartTime together`);
  return icsValue(original, `${where} originalStartTime`);
}

function icsValue(value: JsonObject | undefined, where: string): IcsValue {
  if (value === undefined) refuse(`${where}: is absent`);
  if (typeof value.date === "string") {
    if (value.dateTime !== undefined || value.timeZone !== undefined) refuse(`${where}: a date also states dateTime or timeZone`);
    if (!ics.isDate(value.date)) refuse(`${where}: ${JSON.stringify(value.date)} is not a date`);
    return { params: ";VALUE=DATE", value: value.date.replaceAll("-", ""), occurrence: value.date, form: "date" };
  }
  if (typeof value.dateTime !== "string" || value.date !== undefined) refuse(`${where}: states not exactly one of date and dateTime`);
  const canonical = stated(value.dateTime, where);
  if (canonical.includes(".")) refuse(`${where}: a sub-second DATE-TIME cannot be written as RFC 5545`);
  if (value.timeZone !== undefined) {
    if (typeof value.timeZone !== "string" || !/^[A-Za-z0-9_+./-]+$/u.test(value.timeZone)) refuse(`${where}: timeZone is not a safe TZID`);
    if (value.timeZone !== "UTC") {
      const wall = canonical.slice(0, 19).replace(/[-:]/gu, "");
      return { params: `;TZID=${value.timeZone}`, value: wall, occurrence: canonical, form: "date-time" };
    }
  }
  return { params: "", value: utcBasic(canonical), occurrence: canonical, form: "date-time" };
}

function vevent(item: JsonObject, where: string): string {
  const uid = item.iCalUID as string;
  if (/\r|\n/u.test(uid)) refuse(`${where}: the iCalUID holds a line break`);
  const start = icsValue(isObject(item.start) ? item.start : undefined, `${where} start`);
  const end = icsValue(isObject(item.end) ? item.end : undefined, `${where} end`);
  if (start.form !== end.form) refuse(`${where}: start and end use different value forms`);
  const lines = ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART${start.params}:${start.value}`, `DTEND${end.params}:${end.value}`];
  const instance = recurrence(item, where);
  if (instance !== undefined) lines.push(`RECURRENCE-ID${instance.params}:${instance.value}`);
  if (typeof item.summary === "string") lines.push(`SUMMARY:${escapeText(item.summary)}`);
  if (Array.isArray(item.recurrence)) {
    for (const rule of item.recurrence) {
      if (typeof rule !== "string" || !/^(?:RRULE|RDATE|EXRULE|EXDATE)[;:]/u.test(rule) || /\r|\n/u.test(rule)) refuse(`${where}: a recurrence line is not read`);
      lines.push(rule);
    }
  }
  if (typeof item.status === "string") lines.push(`STATUS:${item.status.toUpperCase()}`);
  if (typeof item.transparency === "string") lines.push(`TRANSP:${item.transparency.toUpperCase()}`);
  const organizer = isObject(item.organizer) ? item.organizer : undefined;
  if (organizer !== undefined) {
    if (typeof organizer.email !== "string" || /[\r\n;]/u.test(organizer.email)) refuse(`${where}: the organizer has no safe email`);
    const cn = typeof organizer.displayName === "string" ? `;CN=${escapeParameter(organizer.displayName)}` : "";
    lines.push(`ORGANIZER${cn}:mailto:${organizer.email}`);
  }
  if (item.attendees !== undefined) {
    if (!Array.isArray(item.attendees)) refuse(`${where}: attendees is not an array`);
    for (const [index, attendee] of item.attendees.entries()) {
      if (!isObject(attendee) || typeof attendee.email !== "string" || /[\r\n;]/u.test(attendee.email)) refuse(`${where}: attendee ${index} has no safe email`);
      const params: string[] = [];
      if (typeof attendee.displayName === "string") params.push(`CN=${escapeParameter(attendee.displayName)}`);
      params.push(attendee.organizer === true ? "ROLE=CHAIR" : attendee.optional === true ? "ROLE=OPT-PARTICIPANT" : "ROLE=REQ-PARTICIPANT");
      if (attendee.responseStatus !== undefined) {
        const status = typeof attendee.responseStatus === "string" ? RESPONSES[attendee.responseStatus] : undefined;
        if (status === undefined) refuse(`${where}: attendee responseStatus ${JSON.stringify(attendee.responseStatus)} is not read`);
        params.push(`PARTSTAT=${status}`);
      }
      lines.push(`ATTENDEE;${params.join(";")}:mailto:${attendee.email}`);
    }
  }
  if (typeof item.description === "string") lines.push(`DESCRIPTION:${escapeText(item.description)}`);
  if (typeof item.location === "string") lines.push(`LOCATION:${escapeText(item.location)}`);
  if (typeof item.created === "string") lines.push(`CREATED:${stamp(item.created, `${where} created`)}`);
  if (typeof item.updated === "string") lines.push(`LAST-MODIFIED:${stamp(item.updated, `${where} updated`)}`);
  if (item.sequence !== undefined) {
    if (typeof item.sequence !== "number" || !Number.isSafeInteger(item.sequence) || item.sequence < 0) refuse(`${where}: sequence is not a count`);
    lines.push(`SEQUENCE:${item.sequence}`);
  }
  lines.push("END:VEVENT");
  return `${lines.flatMap(fold).join("\r\n")}\r\n`;
}

const RESPONSES: Record<string, string> = { accepted: "ACCEPTED", declined: "DECLINED", tentative: "TENTATIVE", needsAction: "NEEDS-ACTION" };

function fold(line: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const scalar of line) {
    if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(scalar, "utf8") > 75) {
      out.push(current);
      current = ` ${scalar}`;
    } else {
      current += scalar;
    }
  }
  out.push(current);
  return out;
}

function escapeText(value: string): string {
  return value.replaceAll("\\", "\\\\").replace(/\r\n|\r|\n/gu, "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");
}

function escapeParameter(value: string): string {
  return `"${value.replaceAll("^", "^^").replace(/\r\n|\r|\n/gu, "^n").replaceAll('"', "^'")}"`;
}


export const gcalExport: Reader = {
  name: "gcal-export",
  kinds: { event },
  async *read(delivery, files) {
    const account = channelAccount(delivery.source, "export");
    if (!forThisAccount(delivery)) return;
    if (delivery.facts.import !== undefined) {
      let read: Member[] = [];
      yield* consuming(delivery, archive(delivery, files, (members) => {
        read = members.filter((member) => TAKEOUT_CALENDAR.test(member.name));
        return calendarRows(read, account);
      }), () => read);
      return;
    }
    const sorted = [...delivery.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const direct = sorted.filter((file) => /\.ics$/iu.test(file.path));
    yield* zipped(direct.length > 0 ? { ...delivery, files: [] } : delivery, files, (members) =>
      calendarRows([...direct.map((file) => fileMember(files, file)), ...members.filter((member) => /\.ics$/iu.test(member.name))], account));
  },
};

const TAKEOUT_CALENDAR = /(?:^|\/)Takeout\/Calendar\/.+\.ics$/iu;

async function* calendarRows(calendars: readonly Member[], account: string): AsyncGenerator<ReaderOutput> {
  yield* each(calendars, (calendar) => calendar.where, (calendar) => {
    const named = filenameAccount(basename(calendar.name));
    if (named !== null && named !== account && !named.endsWith(`_${account}`)) refuse(`${calendar.where}: its filename names account ${JSON.stringify(named)}, not the source's`);
    const parsed = ics.parseCalendar(calendar.bytes(), calendar.where);
    const where = (index: number, component: ics.IcsComponent) => `${calendar.where}:VEVENT ${index} at byte ${component.startByte}`;
    return each(parsed.events.entries(), ([index, component]) => where(index, component), ([index, component]) => [exportRow(component, parsed.zones, where(index, component))]);
  });
}

function filenameAccount(name: string): string | null {
  const stem = name.toLowerCase().endsWith(".ics") ? name.slice(0, -4) : name;
  return /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/u.exec(stem)?.[1]?.toLowerCase() ?? null;
}

function exportRow(component: ics.IcsComponent, zones: ReadonlyMap<string, ics.VTimezone>, where: string): ReaderOutput {
  const uid = ics.single(component, "UID", where);
  if (uid === undefined || uid.value.length === 0) refuse(`${where}: states no UID`);
  let key = uid.value;
  const instance = ics.single(component, "RECURRENCE-ID", where);
  if (instance !== undefined) {
    if (instance.value.length === 0) refuse(`${where}: RECURRENCE-ID is empty`);
    const parsed = ics.timeValue(instance, `${where} RECURRENCE-ID`);
    key = `${uid.value}:${occurrenceKey(parsed.form === "date" ? parsed.date : ics.timedText(parsed, zones, `${where} RECURRENCE-ID`))}`;
  }
  return { kind: "event", key, content: { type: "calendar.event", content: component.content }, time: exportTime(component, zones, where), locator: where };
}

function exportTime(component: ics.IcsComponent, zones: ReadonlyMap<string, ics.VTimezone>, where: string): Instant {
  const startProperty = ics.single(component, "DTSTART", where);
  const endProperty = ics.single(component, "DTEND", where);
  if (startProperty === undefined || endProperty === undefined) refuse(`${where}: needs both DTSTART and DTEND`);
  const start = ics.timeValue(startProperty, `${where} DTSTART`);
  const end = ics.timeValue(endProperty, `${where} DTEND`);
  if (start.form === "date" || end.form === "date") {
    if (start.form !== "date" || end.form !== "date") refuse(`${where}: DTSTART and DTEND mix dates and times`);
    if (end.date <= start.date) refuse(`${where}: a date DTEND must be after DTSTART`);
    return span(instant(start.date, "date"), instant(addDays(end.date, -1), "date"));
  }
  return interval(ics.timedText(start, zones, `${where} DTSTART`), ics.timedText(end, zones, `${where} DTEND`), where);
}


function occurrenceKey(occurrence: string): string {
  return ics.isDate(occurrence) ? occurrence.replaceAll("-", "") : utcBasic(occurrence);
}

const STAMP = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/u;

function stated(text: string, where: string): string {
  const match = STAMP.exec(text) ?? refuse(`${where}: ${JSON.stringify(text)} is not a full RFC 3339 time`);
  if (match[4] === "-00:00") refuse(`${where}: -00:00 states no offset`);
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  const canonical = `${match[1]}T${match[2]}${fraction === "" ? "" : `.${fraction}`}${match[4] === "z" ? "Z" : match[4]}`;
  instantOf(canonical, "rfc3339", where);
  return canonical;
}

function stamp(text: string, where: string): string {
  const [, date, clock, , zone] = STAMP.exec(text) ?? refuse(`${where}: ${JSON.stringify(text)} is not a full RFC 3339 time`);
  if (zone === "-00:00") refuse(`${where}: -00:00 states no offset`);
  const offset = /^([+-])(\d{2}):(\d{2})$/u.exec(zone!);
  if (offset !== null && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) refuse(`${where}: ${zone} is not an offset`);
  const wall = Date.parse(`${date}T${clock}Z`);
  if (Number.isNaN(wall) || new Date(wall).toISOString().slice(0, 19) !== `${date}T${clock}`) refuse(`${where}: ${JSON.stringify(text)} is not a calendar date and clock`);
  const minutes = offset === null ? 0 : (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
  const spelled = basicInstant(wall - minutes * 60_000);
  if (!/^\d{8}T\d{6}Z$/u.test(spelled)) refuse(`${where}: ${JSON.stringify(text)} lies outside the years a DATE-TIME spells`);
  return spelled;
}

function utcBasic(text: string): string {
  return basicInstant(Math.floor(instantOf(text, "rfc3339", text).start_ms / 1000) * 1000);
}

function interval(start: string, end: string, where: string): Instant {
  return spanOf(instantOf(start, "rfc3339", where), instantOf(end, "rfc3339", where), where);
}

function channelAccount(source: string, copy: "cloud" | "export"): string {
  const name = sourceName(source);
  if (name.copy !== copy) refuse(`${source} is not a google-calendar:<account>:${copy} source`);
  return name.account;
}

function fileAt(delivery: Delivery, path: string): DeliveryFile | undefined {
  return delivery.files.find((file) => file.path === path);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}


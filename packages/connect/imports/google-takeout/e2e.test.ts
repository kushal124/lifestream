import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withRoadDefaults, type Connector } from "../../declaration.js";
import { declarations, providers } from "../../index.js";
import { kindReads } from "../reads.js";
import { fileMember, type Member } from "../../shared/members.js";
import { matches } from "../../shared/patterns.js";
import { artifact, deliver, openTestHome, temp, writeZip } from "../../test/drive.js";
import { importKinds, listImport, listingHash, type ImportKind } from "../index.js";
import { googleTakeout, stampInstant, stampOfName } from "./import.js";

const readers = () => providers().flatMap((provider) => provider.readers);
const takeout = (connectors: readonly Connector[] = declarations()): ImportKind => importKinds(connectors, readers()).find((kind) => kind.id === "google-takeout")!;
const routed = (path: string, kind = takeout()) => kind.reads.filter((read) => matches(read.members, `Takeout/${path}`)).map((read) => `${read.product}:${read.copy} ${read.connector}`);

function members(files: Readonly<Record<string, string>>): Member[] {
  const home = openTestHome();
  const delivery = deliver(home, "google-takeout:test", Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)])), {}, 0);
  return delivery.files.map((file) => fileMember(home.blobs, file));
}

describe("Takeout routing: each of these is impossible", () => {
  it("a Takeout member is routed by anything but a declared pattern, to another copy, or read by another reader", () => {
    expect(routed("Mail/All mail Including Spam and Trash.mbox")).toEqual(["gmail:cloud gmail-takeout"]);
    expect(routed("Mail/Labels/Inbox.MBOX")).toEqual(["gmail:cloud gmail-takeout"]);
    expect(routed("Calendar/person-a@example.com.ics")).toEqual(["google-calendar:export gcal-export"]);
    expect(routed("Contacts/My Contacts/My Contacts.vcf")).toEqual(["google-contacts:export contacts-vcard"]);
    expect(routed("My Activity/YouTube/MyActivity.json")).toEqual(["youtube:export google-my-activity"]);
    expect(routed("My Activity/Image Search/MyActivity.json")).toEqual(["google-search:export google-my-activity"]);
    expect(routed("Contacts/My Contacts.vcf")).toEqual([]);
    expect(routed("Contacts/a/b/c.vcf")).toEqual([]);
    expect(routed("Mail/User Settings/Labels.json")).toEqual([]);
    expect(routed("My Activity/MyActivity.json")).toEqual([]);
    expect(routed("Drive/notes.txt")).toEqual([]);
    const declared = new Set(declarations().flatMap((connector) => connector.export?.recognise ?? []).filter((pattern) => pattern.startsWith("Takeout/")));
    expect(new Set(takeout().reads.map((read) => read.members))).toEqual(declared);
    expect(takeout().products.map((product) => [product.id, product.folder])).toEqual([
      ["calendar", "Calendar"], ["contacts", "Contacts"], ["google-photos", "Google Photos"], ["mail", "Mail"], ["my-activity", "My Activity"],
    ]);
    artifact(temp(), "takeout-reads.json", takeout().reads);
  });

  it("a connector declares a pattern under the root that is no Takeout product's folder", () => {
    const gmail = declarations().find((connector) => connector.id === "gmail")!;
    expect(() => kindReads(googleTakeout, { ...gmail, export: { recognise: ["Takeout/*.mbox"], product: { id: "mail", name: "Mail" } } }, { id: "mail", name: "Mail" })).toThrow(/no Google Takeout product's folder/u);
  });

  it("a home's connector, its pattern under the root, is routed no member, listed as no product, or leaves the hash", () => {
    const keep: Connector = withRoadDefaults({
      id: "example-keep", product: "example-keep", name: "Example Keep", vendor: "google", records: "Every note's title and text.",
      sources: [{ id: "example-keep:<account>:export", read: "example-keep", arrives: "upload" }],
      export: { recognise: ["Takeout/Keep/*.json"], product: { id: "keep", name: "Keep" } },
    });
    const release = declarations();
    const home = [...release, keep];
    expect(routed("Keep/A note.json", takeout(home))).toEqual(["example-keep:export example-keep"]);
    expect(routed("Keep/A note.json", takeout(release))).toEqual([]);
    expect(takeout(home).products.find((product) => product.id === "keep")).toEqual({ id: "keep", name: "Keep", folder: "Keep" });
    expect(takeout(release).products.some((product) => product.id === "keep")).toBe(false);
    expect(listingHash(takeout(home))).not.toBe(listingHash(takeout(release)));
  });

  it("a file's account, stamp or time is other than its members and name state, or a stamp that is no instant is one", async () => {
    const profile = JSON.stringify({ emails: [{ value: "Person-A@Example.com", primary: true }, { value: "person-c@example.com" }] });
    const held = members({
      "Takeout/Profile/Profile.json": profile,
      "Takeout/Calendar/person-a@example.com.ics": "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      "Takeout/Calendar/Birthdays_person-a@example.com.ics": "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      "Takeout/Mail/All mail Including Spam and Trash.mbox": "",
      "Takeout/archive_browser.html": "<html>takeout-20261027T103000Z</html>",
    });
    expect(await takeout().resolve(held)).toEqual({ products: [{ id: "calendar", named: ["person-a@example.com"] }, { id: "mail", named: ["person-a@example.com"] }] });
    expect(await googleTakeout.named(members({ "Takeout/Profile/Profile.json": JSON.stringify({ emails: ["person-a@example.com", { value: "person-b@example.com" }] }) }))).toEqual({ named: ["person-a@example.com", "person-b@example.com"] });
    expect(await takeout().resolve(members({ "Takeout/Google Photos/IMG_0001.jpg": "x" }))).toEqual({ products: [{ id: "google-photos", named: [] }] });
    expect(await takeout().stamp("takeout-20261101T090000Z-3-001 (1).zip", held)).toBe("20261101T090000Z");
    expect(await takeout().stamp("my-takeout.zip", held)).toBe("20261027T103000Z");
    expect(await takeout().stamp("my-takeout.zip", members({ "Takeout/Mail/a.mbox": "" }))).toBeNull();
    expect(await takeout().states("takeout-20261101T090000Z-001.zip", held, null)).toEqual({ time_ms: Date.UTC(2026, 10, 1, 9) });
    expect(await takeout().states("other.zip", members({ "Takeout/Mail/a.mbox": "" }), null)).toEqual({ time_ms: null });
    expect([stampOfName("takeout-20261332T090000Z-001.zip"), stampOfName("photos-20261101T090000Z.zip"), stampInstant("20260229T000000Z")]).toEqual([null, null, null]);
  });

  it("a listing of a Takeout zip and its unzipped folder differ in products, routes or what holds a file back", async () => {
    const files: Record<string, Buffer> = {
      "Takeout/Mail/All mail Including Spam and Trash.mbox": Buffer.from(""),
      "Takeout/Mail/User Settings/Labels.json": Buffer.from("{}"),
      "Takeout/Calendar/person-a@example.com.ics": Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR"),
      "Takeout/Calendar/photo.jpg": Buffer.from("not text"),
      "Takeout/Drive/notes.bin": Buffer.from("unread"),
      "Takeout/archive_browser.html": Buffer.from("<html></html>"),
    };
    const zip = join(temp("takeout-zip-"), "takeout-20261027T103000Z-001.zip");
    writeZip(zip, Object.entries(files).map(([name, bytes]) => ({ name, bytes })));
    const home = openTestHome();
    const listings = [];
    for (const delivered of [{ "takeout-20261027T103000Z-001.zip": readFileSync(zip) }, Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`takeout-20261027T103000Z-001/${path}`, bytes]))]) {
      const { listing } = await listImport(takeout(), deliver(home, "google-takeout:test", delivered, {}, 0), home.blobs);
      listings.push({
        products: listing.products.map((product) => [product.id, product.reads, product.unclaimed]),
        routes: listing.routes.map((route) => [route.product, route.copy, route.files.length]),
        held: listing.files.map((file) => file.unclaimed ?? 0),
      });
    }
    expect(listings[0]).toEqual({
      products: [["calendar", true, 1], ["drive", false, 0], ["mail", true, 0]],
      routes: [["gmail", "cloud", 1], ["google-calendar", "export", 1]],
      held: [1],
    });
    expect(listings[1]).toEqual(listings[0]);
  });
});

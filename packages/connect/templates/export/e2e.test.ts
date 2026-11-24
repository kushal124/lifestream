import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMED, type Delivery } from "@lifestreamprotocol/connect/sdk";
import { importKinds, listImport, type ImportKind } from "../../imports/index.js";
import { artifact, deliver, openTestHome, readStoring, temp, writeZip, type TestHome } from "../../test/drive.js";
import { exampleExport as exampleExportConnector } from "./connector.js";
import { exampleExport } from "./reader.js";
import { ACCOUNT, download, SOURCE } from "./test/fixture.js";

const FACTS = { exported_at: "2026-09-01T00:00:00.000Z" };
const HEADS = [
  ["note-001", Date.parse("2026-08-01T08:00:00.000Z")], ["note-002", Date.parse("2026-08-02T08:00:00.000Z")], ["note-003", Date.parse("2026-08-03T08:00:00.000Z")],
];

const kind = (): ImportKind => importKinds([exampleExportConnector], [exampleExport])[0]!;

function zipped(home: TestHome, members = download()): Delivery {
  const zip = join(temp("example-export-zip-"), "example-export-2026-09-01.zip");
  writeZip(zip, Object.entries(members).map(([path, bytes]) => ({ name: path, bytes })));
  return deliver(home, SOURCE, { "example-export-2026-09-01.zip": readFileSync(zip) }, FACTS);
}
const extracted = (home: TestHome, members = download()): Delivery => deliver(home, SOURCE, members, FACTS);

async function resolved(home: TestHome, delivery: Delivery) {
  const { listing, found } = await listImport(kind(), delivery, home.blobs, { look: (members) => kind().resolve(members) });
  return { listing, resolved: found };
}

describe("example export: each of these is impossible", () => {
  it("the download is no kind, or a kind of another name, words or rows than its declaration's", () => {
    const made = kind();
    expect([made.id, made.name, made.takes, made.ask, made.vendor, made.recognise]).toEqual(["example-export", "Example", "Example sends a download you ask for", "Whose Example is this?", "example", ["**/notes*.json"]]);
    expect(made.reads).toEqual([{ of: "example", members: "**/notes*.json", product: "example", copy: "export", connector: "example-export" }]);
    expect(made.products).toEqual([{ id: "example", name: "Example", noun: ["note", "notes"] }]);
  });

  it("a download handed in as its zip, or as its folder, names any account but its account.json's, or lands other heads", async () => {
    for (const make of [zipped, extracted]) {
      const home = openTestHome();
      const delivery = make(home);
      const { listing, resolved: whose } = await resolved(home, delivery);
      expect(whose).toEqual({ products: [{ id: "example", named: [ACCOUNT] }] });
      expect(listing.routes.map((route) => [route.of, route.product, route.copy, route.connector])).toEqual([["example", "example", "export", "example-export"]]);
      expect(await home.land(exampleExport, delivery)).toMatchObject({ new: 3, refused: 0 });
      expect(home.heads(SOURCE).map((head) => [head.key, head.start_ms])).toEqual(HEADS);
      artifact(home.dir, "heads.json", home.heads(SOURCE));
    }
  });

  it("a download that names no account is not asked, two are not both named, or one that is not Example's is not refused in words", async () => {
    const home = openTestHome();
    const { "example-export/account.json": _, ...unnamed } = download();
    expect((await resolved(home, zipped(home, unnamed))).resolved).toEqual({ products: [{ id: "example", named: [] }] });
    const twice = { ...download(), "other/account.json": Buffer.from(JSON.stringify({ email: "Person-B@Example.com" })) };
    expect((await resolved(home, zipped(home, twice))).resolved).toEqual({ products: [{ id: "example", named: [ACCOUNT, "person-b@example.com"] }] });
    expect((await resolved(home, zipped(home, { ...download(), "example-export/account.json": Buffer.from("{}") }))).resolved)
      .toEqual({ refused: "account.json states no email: is it Example's download, as downloaded?" });
    expect((await resolved(home, zipped(home, { ...download(), "example-export/account.json": Buffer.from("not json") }))).resolved).toEqual({ products: [{ id: "example", named: [] }] });
  });

  it("another account's download, delivered to this source, lands", async () => {
    const home = openTestHome();
    await expect(home.land(exampleExport, deliver(home, SOURCE, download("person-b@example.com"), FACTS))).rejects.toThrow(/names person-b@example.com/u);
  });

  it("a download read whole as an import is kept for good, or one holding a member no row reads is let go", async () => {
    const home = openTestHome();
    const consumed = async (delivery: Delivery) => (await readStoring(exampleExport, { ...delivery, facts: { ...delivery.facts, import: { kind: "example-export", id: "import-0001" } } }, home.blobs))
      .filter((row) => row.kind === CONSUMED).map((row) => row.key);
    expect(await consumed(zipped(home))).toEqual(["example-export-2026-09-01.zip"]);
    expect(await consumed(zipped(home, { ...download(), "example-export/photo.png": Buffer.from("synthetic bytes no row reads") }))).toEqual([]);
  });

  it("a bad note costs another", async () => {
    const home = openTestHome();
    const files = { ...download(), "example-export/notes-2.json": Buffer.from(JSON.stringify([{ title: "no id" }, { id: "note-004", title: "Synthetic note 4", created_at: "2026-08-04T08:00:00.000Z" }])) };
    expect(await home.land(exampleExport, deliver(home, SOURCE, files, FACTS))).toMatchObject({ new: 3, refused: 1 });
  });
});

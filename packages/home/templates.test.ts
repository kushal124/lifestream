import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { templateKinds, templatePages, templatesFolder } from "./templates.js";

function copied(kind: string, page = `${kind}.md`): string {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-templates-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(templatesFolder(), kind), dir, { recursive: true });
  if (page !== `${kind}.md`) writeFileSync(join(dir, page), readFileSync(join(dir, `${kind}.md`)));
  rmSync(join(dir, `${kind}.md`));
  return dir;
}

describe("a page still the template's", () => {
  it("names a draft's page as copied, renamed, of every kind", () => {
    for (const kind of templateKinds()) {
      const dir = copied(kind, "acme-notes.md");
      const text = readFileSync(join(dir, "acme-notes.md"), "utf8");
      writeFileSync(join(dir, "acme-notes.md"), text.replace(/\bExample\b/gu, "Acme Notes"));
      expect(templatePages(dir), kind).toEqual([{ page: "acme-notes.md", kind }]);
    }
  });

  it("names a page that kept the template's opening under its own heading", () => {
    const dir = copied("oauth", "acme-notes.md");
    const text = readFileSync(join(dir, "acme-notes.md"), "utf8");
    writeFileSync(join(dir, "acme-notes.md"), text.replace(/^# .*$/mu, "# Acme Notes"));
    expect(templatePages(dir)).toEqual([{ page: "acme-notes.md", kind: "oauth" }]);
  });

  it("names a page that kept its template heading, its words rewritten below it", () => {
    const dir = copied("export", "acme-notes.md");
    writeFileSync(join(dir, "acme-notes.md"), "# Acme Notes (export template)\n\nAcme's download, handed in: its notes, each by its id.\n");
    expect(templatePages(dir)).toEqual([{ page: "acme-notes.md", kind: "export" }]);
  });

  it("names nothing of a written page that quotes a template's opening sentence", () => {
    const dir = copied("oauth", "acme-notes.md");
    writeFileSync(join(dir, "acme-notes.md"), [
      "# Acme Notes", "", "Acme's notes through its API, signed in with an OAuth client the person makes at Acme.", "",
      "## How it was drafted", "", "It began as `lifestream connectors new oauth acme-notes`, whose page opened \"The `oauth` kind's template (…)\"; every word here is Acme's.", "",
    ].join("\n"));
    expect(templatePages(dir)).toEqual([]);
  });

  it("names nothing of a page written for its connector, a folder with no page, or a template's own folder", () => {
    const dir = copied("export", "acme-notes.md");
    writeFileSync(join(dir, "acme-notes.md"), "# Acme Notes\n\nAcme's download, handed in: its notes, each by its id.\n");
    expect(templatePages(dir)).toEqual([]);
    expect(templatePages(copied("export"))).toEqual([]);
    for (const kind of templateKinds()) expect(templatePages(join(templatesFolder(), kind)), kind).toEqual([]);
  });
});

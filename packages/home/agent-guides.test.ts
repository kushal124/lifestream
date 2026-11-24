import { describe, expect, it } from "vitest";
import { appOfHost, appOfReader, GUIDE_APPS, guidesOf, HOST_SLOT, keyWholeOn, markOf, NAME_SLOT, signInFrom, siteOf, type GuideReader, type Guides } from "./agent-guides.js";
import { PAGES, type Guide } from "./pages.js";
import { clientFixture } from "./test/harness-root.js";
import { GUIDE_NOW, guidesAnswer, guidesBody } from "./test/guides.js";

const reader = (over: Partial<GuideReader>): GuideReader => ({ id: "p-0000000a", kind: "agent", via: "sign-in", from: "chatgpt.com", app: null, made_ms: GUIDE_NOW, disconnected_ms: null, ...over });
const links = (guide: Guide) => [...guide.steps.flatMap((step) => ("open" in step && step.open !== null ? [step.open] : [])), ...(guide.done.open === null ? [] : [guide.done.open])];
const byApp = (guides: Guides) => Object.fromEntries(guides.apps.map((guide) => [guide.app, guide])) as Record<(typeof GUIDE_APPS)[number], Guide>;

describe("a sign-in's app, by its host", () => {
  it("is the guide whose host it is exactly, lowercase, with no port", () => {
    expect([appOfHost("chatgpt.com"), appOfHost("claude.ai"), appOfHost("claude.com"), appOfHost("agent.meta.ai")]).toEqual(["chatgpt", "claude", "claude", "muse"]);
  });

  it("is none for a lookalike, a capital, a port, a subdomain or no host", () => {
    for (const host of ["chatgpt.com.example.com", "CHATGPT.COM", "chatgpt.com:443", "www.chatgpt.com", "evil-chatgpt.com", "muse.ai", "meta.ai", "", null]) expect(appOfHost(host), String(host)).toBeNull();
  });

  it("names a reader's app by a sign-in's host or a key's grant, and marks Chat, a guide's reader and every other agent apart", () => {
    expect([appOfReader(reader({})), appOfReader(reader({ via: "pass", from: null })), appOfReader(reader({ from: "chatgpt.com:8443" }))]).toEqual(["chatgpt", null, null]);
    expect([appOfReader(reader({ via: "pass", from: null, app: "grok-bot" })), appOfReader(reader({ via: "pass", from: null, app: "instinct" }))]).toEqual(["grok-bot", "instinct"]);
    expect(appOfReader(reader({ via: "sign-in", from: "example.com", app: "instinct" })), "a sign-in is named by its host alone").toBeNull();
    expect(appOfReader({ kind: "chat", via: null, from: null, app: "instinct" })).toBeNull();
    expect([markOf(reader({})), markOf(reader({ from: "agent.meta.ai" })), markOf(reader({ via: "pass", from: null })), markOf(reader({ via: "pass", from: null, app: "grok-bot" })), markOf({ kind: "chat", via: null, from: null, app: null })])
      .toEqual(["chatgpt", "muse", "ai-apps", "grok-bot", "chat"]);
  });

  it("says where a guide's sign-in comes from: its host, and Muse's where Muse runs", () => {
    expect([signInFrom("chatgpt", "chatgpt.com"), signInFrom("claude", "claude.com"), signInFrom("muse", "agent.meta.ai")])
      .toEqual(["From chatgpt.com", "From claude.com", "From agent.meta.ai, where Muse runs"]);
  });
});

describe("the guides", () => {
  it("list the six apps in their order, each with its own mark, on both devices", () => {
    for (const device of ["mac", "phone", null] as const) {
      const guides = guidesBody(device);
      expect(guides.apps.map((guide) => guide.app), String(device)).toEqual([...GUIDE_APPS]);
      expect(guides.apps.map((guide) => guide.mark)).toEqual(["claude", "chatgpt", "muse", "grok-bot", "instinct", "add"]);
      expect(guides.apps.map((guide) => guide.line)).toEqual([null, null, null, null, null, "Claude Code, Cursor, a script"]);
    }
  });

  it("open only https links on each app's own domain, and Messages for Instinct", () => {
    for (const device of ["mac", "phone"] as const) {
      for (const guide of guidesBody(device).apps) {
        for (const link of links(guide)) {
          if (link.to === "messages") {
            expect(guide.app).toBe("instinct");
            continue;
          }
          const url = new URL(link.url);
          const site = siteOf(guide.app);
          expect(url.protocol, link.url).toBe("https:");
          expect(site !== null && (url.hostname === site || url.hostname.endsWith(`.${site}`)), `${guide.app} opens ${link.url}`).toBe(true);
        }
      }
    }
  });

  it("do a sign-in app's first step in its sidebar on the Mac and on a computer on the iPhone, with no Open there but Muse's", () => {
    const mac = byApp(guidesBody("mac"));
    const phone = byApp(guidesBody("phone"));
    for (const app of ["claude", "chatgpt"] as const) {
      expect(mac[app].steps.map((step) => step.kind)).toEqual(["add", "yes"]);
      expect(mac[app].steps[0]).toMatchObject({ where: "In the sidebar", open: { to: "web" } });
      expect(phone[app].steps[0]).toMatchObject({ where: "On a computer", open: null });
    }
    expect(mac.chatgpt.steps[0]).toMatchObject({ path: ["Plugins", "Add", "Add custom MCP server"], values: [{ label: "Name", text: "Lifestream", address: false }, { label: "Server URL", text: "", address: true }] });
    expect(mac.claude.steps[0]).toMatchObject({ values: [{ label: "Name", text: "Lifestream", address: false }, { label: "MCP server URL", text: "", address: true }] });
    expect(mac.muse.steps[0]).toMatchObject({ kind: "message", value: { label: "Message", address: true }, open: { to: "web", url: "https://muse.ai/" } });
    expect(phone.muse.steps[0]).toMatchObject({ kind: "message", open: { to: "web", url: "https://muse.ai/" } });
    expect((mac.muse.steps[0] as { value: { text: string } }).value.text.endsWith("The MCP URL is: ")).toBe(true);
    expect(mac.muse.hosts).toEqual(["agent.meta.ai"]);
  });

  it("guide Grok Bot and Another agent on the Mac alone, and Instinct whole on both", () => {
    const mac = byApp(guidesBody("mac"));
    const phone = byApp(guidesBody("phone"));
    expect([mac["grok-bot"], mac.instinct, mac.another].map((guide) => guide.steps.map((step) => step.kind))).toEqual([["sees", "give"], ["message", "sees", "give"], ["name", "sees", "give"]]);
    expect(phone.instinct.steps).toEqual(mac.instinct.steps);
    expect(phone["grok-bot"].steps).toEqual([{ kind: "elsewhere", title: "On your Mac", line: "Grok Bot runs on your Mac. Connect it in Lifestream there." }]);
    expect(phone.another.steps).toEqual([{ kind: "elsewhere", title: "On your Mac", line: "Another agent runs on your Mac. Connect it in Lifestream there." }]);
    expect(mac.instinct.steps[2]).toMatchObject({ warn: "Paste the key only into the secure link, never into Messages.", once: "The key shows only now. Make a new one any time." });
    expect(mac.another.steps[2]).toMatchObject({ title: `Give ${NAME_SLOT} the address and the key`, warn: null });
  });

  it("word every state of a sign-in's yes, leaving only the waiting host to the app, and click Connect on a computer, Muse's tap on the phone", () => {
    for (const device of ["mac", "phone"] as const) {
      const yeses = byApp(guidesBody(device));
      for (const app of ["claude", "chatgpt", "muse"] as const) {
        const { name } = yeses[app];
        const click = app === "muse" && device === "phone" ? "tap" : "click";
        expect(yeses[app].steps[1], `${app} on the ${device}`).toMatchObject({
          kind: "yes", sees: "It will see", other: `A sign-in from ${HOST_SLOT} is waiting`,
          wrong: `That wasn’t the number ${name} showed. In ${name}, ${click} Connect to try again.`,
          finishing: `Finishing in ${name}…`,
          unfinished: `${name} did not finish. In ${name}, ${click} Connect again.`,
          out: `The request ended. In ${name}, ${click} Connect to ask again.`,
          denied: `Not allowed. ${name} can’t read your Lifestream.`,
          reads: `${name} can read your Lifestream`,
        });
      }
    }
  });

  it("set up Tailscale first in every guide an agent reaches over the internet, worded for the device, and in none on the Mac alone", () => {
    for (const device of ["mac", "phone"] as const) {
      const guides = byApp(guidesBody(device));
      const on = device === "mac" ? "this Mac" : "your Mac";
      for (const app of ["claude", "chatgpt", "muse", "instinct"] as const) {
        expect(guides[app].address, `${app} on the ${device}`).toEqual({
          title: device === "mac" ? "Set up Tailscale" : "Set up Tailscale on your Mac",
          line: `${guides[app].name} reaches ${on} through Tailscale, a free app.`,
          ready: "Tailscale is ready. Turn on Lifestream’s agent address.", on: "Turn on",
        });
      }
      expect(guides.another.address, `Another agent reads on the Mac itself, on the ${device}`).toBeNull();
    }
    expect([byApp(guidesBody("mac"))["grok-bot"].address?.title, byApp(guidesBody("phone"))["grok-bot"].address]).toEqual(["Set up Tailscale", null]);
  });

  it("word a key's lost reply and what it will see in the guide, on every app that makes one", () => {
    const steps = guidesBody("mac").apps.flatMap((guide) => guide.steps);
    expect(steps.filter((step) => step.kind === "give").map((step) => step.unknown)).toEqual(["Grok Bot", "Instinct", NAME_SLOT].map((name) =>
      `Lifestream didn’t say whether the key was made. Make it again. If Agents then lists ${name} twice, disconnect the one that hasn’t read.`));
    expect(steps.filter((step) => step.kind === "sees").map((step) => step.sees)).toEqual(Array(3).fill("It will see"));
  });

  it("show what a key's agent will see with no call: the default access, drawn for that app", () => {
    const sees = guidesBody("mac").apps.flatMap((guide) => guide.steps.filter((step) => step.kind === "sees").map((step) => [guide.app, step] as const));
    expect(sees.map(([app]) => app)).toEqual(["grok-bot", "instinct", "another"]);
    for (const [, step] of sees) expect(step).toMatchObject({ make: "Make the key", access: { allow: [{ reach: { all: true, but: ["health", "money"] } }] } });
    expect((sees[0]![1] as { view: { sentence: { text: string }[] } }).view.sentence[0]!.text).toContain("Grok Bot");
  });

  it("mark an app connected by its newest connected reader, never a disconnected one or Another agent", () => {
    const guides = byApp(guidesBody("mac"));
    expect([guides.claude.connected, guides.chatgpt.connected, guides.muse.connected, guides.another.connected]).toEqual([null, "p-00000002", null, null]);
    expect(byApp(guidesOf([], "mac", () => ({ access: null, view: null }))).chatgpt.connected).toBeNull();
  });

  it("mark a key app connected by the newest connected key its guide made", () => {
    const key = (id: string, app: "grok-bot" | "instinct", made_ms: number, disconnected_ms: number | null = null) => reader({ id, via: "pass", from: null, app, made_ms, disconnected_ms });
    const readers = [key("p-0000000b", "instinct", GUIDE_NOW - 60_000), key("p-0000000c", "instinct", GUIDE_NOW), key("p-0000000d", "grok-bot", GUIDE_NOW, GUIDE_NOW), reader({ id: "p-0000000e", via: "pass", from: null })];
    const guides = byApp(guidesOf(readers, "phone", () => ({ access: null, view: null })));
    expect([guides["grok-bot"].connected, guides.instinct.connected, guides.another.connected]).toEqual([null, "p-0000000c", null]);
  });

  it("let a phone make a key only for an app its guide shows whole there", () => {
    expect([keyWholeOn("instinct", "phone"), keyWholeOn("grok-bot", "phone"), keyWholeOn("another", "phone")]).toEqual([true, false, false]);
    expect([keyWholeOn("instinct", "mac"), keyWholeOn("grok-bot", "mac"), keyWholeOn("another", null)]).toEqual([true, true, true]);
  });

  it("are the page fixtures both apps read, each parsing by the page's shape", () => {
    for (const device of ["mac", "phone"] as const) {
      const answer = guidesAnswer(device);
      expect(() => PAGES.agentGuides.shape.parse(answer)).not.toThrow();
      const fixture = clientFixture(`pages/agentGuides.${device}`, answer);
      expect(fixture.held, `homelink/Tests/Fixtures/pages/agentGuides.${device}.json is this answer: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
    }
  });
});

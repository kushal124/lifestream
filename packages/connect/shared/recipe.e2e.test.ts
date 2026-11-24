import { describe, expect, it } from "vitest";
import { NeedsYou, NotYet } from "../seams.js";
import { FakeRelay, type FakePage } from "../test/station.js";
import type { Connector } from "../declaration.js";
import { RecipeBroken, runSteps, signInAgain, type Recipe } from "./recipe.js";
import { memorySecrets } from "../test/drive.js";
import { stationsOver, type ErrandSpec } from "./station.js";
import { recipes } from "../health/whoop/recipe.js";

const TOKEN = "drive-token-synthetic";
const ORIGIN = "https://data.example";
const PASSWORD = "password-synthetic-0001";

class Provider {
  asked = 0;
  password = false;
  button = "Request data";
  preparing = false;
  readonly field = { role: "textbox", name: "Password", label: "Password", value: undefined as string | undefined };
  readonly boxes = [
    { role: "checkbox", name: "Select Account data", checked: true },
    { role: "checkbox", name: "Select Extended history", checked: false },
  ];
  answer() {
    return { status: 404 };
  }
  page(url: URL): FakePage | undefined {
    if (url.pathname === "/privacy" && this.password) {
      return {
        elements: [this.field, { role: "button", name: "Confirm", click: () => void (this.password = this.field.value !== PASSWORD) }],
        signals: { password: true },
      };
    }
    if (url.pathname === "/") return { elements: [], redirect: "https://app.data.example/" };
    if (url.pathname === "/privacy" && this.preparing) return { elements: [{ role: "heading", name: "Preparing Account data" }, { role: "button", name: this.button }] };
    if (url.pathname === "/privacy") return { elements: [...this.boxes, { role: "button", name: this.button, click: () => (this.asked++, "/privacy/asked") }] };
    if (url.pathname === "/privacy/asked") return { elements: [{ role: "heading", name: "We got your request" }] };
    if (url.pathname === "/login") return { elements: [{ role: "textbox", name: "Email" }], signals: { password: true } };
    return undefined;
  }
}

const RECIPE: Recipe = {
  name: "data-export-request",
  version: 1,
  site: "Data",
  origins: [ORIGIN],
  busy: { role: "heading", name: "Preparing" },
  secrets: ["data.password"],
  steps: [
    { id: "privacy", do: "open", url: `${ORIGIN}/privacy` },
    { id: "password", do: "fill", when: { label: "Password" }, target: { label: "Password" }, secret: "data.password" },
    { id: "confirm", do: "click", when: { label: "Password" }, target: { role: "button", name: "Confirm" } },
    { id: "account", do: "tick", target: { role: "checkbox", name: "Select Account data" } },
    { id: "history", do: "tick", target: { role: "checkbox", name: "Select Extended history" } },
    { id: "request", do: "click", target: { role: "button", name: "Request data" }, then: { role: "heading", name: "We got your request" } },
  ],
};

const errandOf = (recipe: Recipe): ErrandSpec => ({ name: recipe.name, origins: recipe.origins, secrets: recipe.secrets ?? [], deadline_ms: 60_000 });

function station(provider: Provider, secrets: Record<string, string> = {}) {
  const relay = new FakeRelay(provider, TOKEN);
  return { relay, stations: stationsOver("https://door.example", TOKEN, { fetch: relay.fetch, secrets: memorySecrets({ ...secrets }) }) };
}

async function run(provider: Provider, recipe: Recipe, secrets: Record<string, string> = {}, params: Record<string, string> = {}) {
  const { stations } = station(provider, secrets);
  return stations.using(errandOf(recipe), async (errand) =>
    runSteps(await errand.open(`${ORIGIN}/privacy`), recipe, { params }));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("recipes", () => {
  it("runs each step on the page it expects, leaving a ticked box ticked (1)", async () => {
    const provider = new Provider();
    expect(await run(provider, RECIPE)).toBe("request");
    expect(provider.asked).toBe(1);
    expect(provider.boxes.map((box) => box.checked)).toEqual([true, true]);
  });

  it("names one button in each language, the first the page shows taken", async () => {
    const provider = new Provider();
    provider.button = "डेटा का अनुरोध करें";
    const both = { ...RECIPE, steps: RECIPE.steps.map((step) => (step.id === "request" ? { ...step, target: [{ role: "button", name: "Request data" }, { role: "button", name: "डेटा का अनुरोध करें" }] } : step)) };
    expect(await run(provider, both)).toBe("request");
    expect(provider.asked).toBe(1);
  });

  it("fills a password the home holds into the page, sent as a secret the errand names, and asks the person for one it does not (4)", async () => {
    const provider = new Provider();
    provider.password = true;
    const { relay, stations } = station(provider, { "data.password": PASSWORD });
    expect(await stations.using(errandOf(RECIPE), async (errand) => runSteps(await errand.open(`${ORIGIN}/privacy`), RECIPE))).toBe("request");
    expect(provider.field.value).toBe(PASSWORD);
    expect([...relay.filled]).toEqual([["data.password", PASSWORD]]);
    expect(provider.asked).toBe(1);

    const again = new Provider();
    again.password = true;
    const error = await failure(run(again, RECIPE));
    expect(error).toBeInstanceOf(NeedsYou);
    expect((error as NeedsYou).reason).toBe("password");
    expect((error as NeedsYou).at).toEqual({ site: "data.example" });
    expect(again.asked).toBe(0);

    const unnamed = { ...RECIPE, secrets: [] };
    await expect(run(again, unnamed, { "data.password": PASSWORD })).rejects.toThrow(/does not name/u);
    expect(again.field.value).toBeUndefined();
  });

  it("says at which step a changed page breaks the recipe, and passes once it is back (2)", async () => {
    const provider = new Provider();
    provider.button = "Download your data";
    const ran = await failure(run(provider, RECIPE));
    expect(ran).toBeInstanceOf(RecipeBroken);
    expect(ran).toMatchObject({ recipe: "data-export-request", version: 1, step: "request", code: "TIMEOUT" });
    expect((ran as RecipeBroken).page?.lines).toContain('button "Download your data"');
    expect(provider.asked).toBe(0);
    provider.button = "Request data";
    expect(await run(provider, RECIPE)).toBe("request");
    expect(provider.asked).toBe(1);
  });

  it("reads a page still making an earlier export as not yet, neither broken nor passed (5)", async () => {
    const provider = new Provider();
    provider.preparing = true;
    const ran = await failure(run(provider, RECIPE));
    expect(ran).toBeInstanceOf(NotYet);
    expect(ran).toMatchObject({ reason: "provider-making", facts: { step: "making" } });
    expect(provider.asked).toBe(0);
  });

  it("reads a page asking for the person as theirs, not as a broken recipe (3)", async () => {
    const provider = new Provider();
    const { relay, stations } = station(provider);
    const signedOut = { ...RECIPE, steps: [{ id: "privacy", do: "open" as const, url: `${ORIGIN}/login` }, ...RECIPE.steps.slice(3)] };
    const outcome = await failure(stations.using(errandOf(signedOut), async (errand) => runSteps(await errand.open(`${ORIGIN}/privacy`), signedOut)));
    expect(outcome).toBeInstanceOf(NeedsYou);
    expect(outcome).toMatchObject({ reason: "password", at: { site: "data.example", errand: "errand-1" } });
    expect([relay.open, provider.asked]).toEqual([1, 0]);
  });

  it("puts a lane's parameter into a step, and refuses one not given, or given empty (7)", async () => {
    const provider = new Provider();
    const profiled: Recipe = { ...RECIPE, params: ["box"], steps: RECIPE.steps.map((step) => (step.id === "history" ? { ...step, target: { role: "checkbox", name: "Select ${box}" } } : step)) };
    expect(await run(provider, profiled, {}, { box: "Extended history" })).toBe("request");
    await expect(run(new Provider(), profiled)).rejects.toThrow(/no parameter "box"/u);
    await expect(run(new Provider(), profiled, {}, { box: "" })).rejects.toThrow(/no parameter "box"/u);
  });
});

const APP = "https://app.whoop.com";
const ID = "https://id.whoop.com";
const KEPT = "whoop.password";
const EMAIL = "person-a@example.com";
const SIGN_IN_PASSWORD = "password-synthetic-0002";

class Site {
  signedIn = false;
  code = false;
  heading = "Sign In";
  signin = `${ID}/sign-in/`;
  readonly email = { role: "textbox", name: "Email", value: undefined as string | undefined };
  readonly password = { role: "textbox", name: "Password", value: undefined as string | undefined };
  answer() {
    return { status: 404 };
  }
  page(url: URL): FakePage | undefined {
    if (url.origin === APP) return this.signedIn ? { elements: [{ role: "heading", name: "Today" }] } : { elements: [], redirect: this.signin };
    if (url.pathname === "/code") return { elements: [{ role: "textbox", name: "Code" }], signals: { otp: true } };
    if (url.pathname === "/sign-in/") {
      const signIn = () => {
        if (this.email.value !== EMAIL || this.password.value !== SIGN_IN_PASSWORD) return;
        if (this.code) return `${url.origin}/code`;
        this.signedIn = true;
        return `${APP}/`;
      };
      return { elements: [{ role: "heading", name: this.heading }, this.email, this.password, { role: "button", name: "Sign In", click: signIn }], signals: { password: true } };
    }
    return undefined;
  }
}

const WHOOP = {
  id: "whoop", product: "whoop", name: "WHOOP", vendor: "whoop", type: "health", records: "Your cycles, sleeps, stress and heart rate, as WHOOP reads them.",
  sources: [{ id: "whoop:<account>:cloud", read: "whoop-capture", arrives: "chrome", feeders: ["whoop"] }], acquirers: ["whoop"],
  chrome: { origin: APP, signin: { origin: ID, recipe: "whoop-sign-in" }, probe: null },
} satisfies Connector;

async function signIn(site: Site, kept: Record<string, string>, connector: Connector = WHOOP, more: readonly string[] = []) {
  const relay = new FakeRelay(site, TOKEN);
  const answers: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await relay.fetch(input, init);
    answers.push(await response.clone().text());
    return response;
  };
  const secrets = memorySecrets({ ...kept });
  const stations = stationsOver("https://door.example", TOKEN, { fetch, secrets });
  const spec = { name: "whoop", origins: [APP, ID, ...more], secrets: [KEPT], deadline_ms: 10 * 60_000 };
  const outcome = await stations.using(spec, async (errand) => {
    await signInAgain(await errand.open(`${APP}/`), connector, { params: { email: EMAIL, password: KEPT }, secrets, recipes });
    return "signed in";
  }).catch((error: unknown) => error);
  return { outcome, answers, relay };
}

describe("signing in again (6)", () => {
  it("signs a page sent to the site's sign-in in again by its recipe, the password in its field alone", async () => {
    const site = new Site();
    const { outcome, answers, relay } = await signIn(site, { [KEPT]: SIGN_IN_PASSWORD });
    expect(outcome).toBe("signed in");
    expect(site.signedIn).toBe(true);
    expect([site.email.value, site.password.value]).toEqual([EMAIL, SIGN_IN_PASSWORD]);
    expect([...relay.filled]).toEqual([["whoop.password", SIGN_IN_PASSWORD]]);
    expect(answers.filter((answer) => answer.includes(SIGN_IN_PASSWORD))).toEqual([]);
    expect(relay.open).toBe(0);
    site.email.value = undefined;
    const again = await signIn(site, { [KEPT]: SIGN_IN_PASSWORD });
    expect([again.outcome, site.email.value, again.relay.filled.size]).toEqual(["signed in", undefined, 0]);
  });

  it("runs the recipe on no page but the declared sign-in origin, and leaves a site with no recipe to the person", async () => {
    const elsewhere = new Site();
    elsewhere.signin = "https://www.whoop.example/sign-in/";
    const { outcome, relay } = await signIn(elsewhere, { [KEPT]: SIGN_IN_PASSWORD }, WHOOP, ["https://www.whoop.example"]);
    expect([outcome instanceof NeedsYou && outcome.reason, outcome instanceof NeedsYou && outcome.facts, elsewhere.email.value, relay.filled.size]).toEqual(["password", undefined, undefined, 0]);
    const byHand = new Site();
    const hand = await signIn(byHand, { [KEPT]: SIGN_IN_PASSWORD }, { ...WHOOP, chrome: { origin: APP, signin: { origin: ID }, probe: null } });
    expect([hand.outcome instanceof NeedsYou && hand.outcome.reason, byHand.email.value, hand.relay.filled.size]).toEqual(["password", undefined, 0]);
  });

  it("reads a sign-in page that changed before Sign In as a broken recipe, never the person's password", async () => {
    const changed = new Site();
    changed.heading = "Log In";
    const { outcome, relay } = await signIn(changed, { [KEPT]: SIGN_IN_PASSWORD });
    expect(outcome).toBeInstanceOf(RecipeBroken);
    expect(outcome).toMatchObject({ recipe: "whoop-sign-in", version: 1, step: "email", code: "TIMEOUT" });
    expect((outcome as RecipeBroken).page?.lines).toContain('heading "Log In"');
    expect([changed.email.value, relay.filled.size, changed.signedIn]).toEqual([undefined, 0, false]);
  });

  it("leaves a code asked after Sign In to the person in the tab it kept, and a refused or unkept password to them to type", async () => {
    const coded = new Site();
    coded.code = true;
    const code = await signIn(coded, { [KEPT]: SIGN_IN_PASSWORD });
    expect(code.outcome).toBeInstanceOf(NeedsYou);
    expect((code.outcome as NeedsYou).reason).toBe("confirm");
    expect((code.outcome as NeedsYou).at).toEqual({ site: "id.whoop.com", errand: "errand-1" });
    expect(code.relay.open).toBe(1);

    const refused = await signIn(new Site(), { [KEPT]: "password-synthetic-wrong" });
    expect(refused.outcome).toBeInstanceOf(NeedsYou);
    expect([(refused.outcome as NeedsYou).reason, (refused.outcome as NeedsYou).facts]).toEqual(["password", { secret: "whoop.password", company: "WHOOP", use: "sign-in" }]);
    expect(JSON.stringify(refused.outcome)).not.toContain("password-synthetic-wrong");

    const unkept = new Site();
    const none = await signIn(unkept, {});
    expect(none.outcome).toBeInstanceOf(NeedsYou);
    expect([(none.outcome as NeedsYou).reason, (none.outcome as NeedsYou).says, (none.outcome as NeedsYou).facts, (none.outcome as NeedsYou).answered])
      .toEqual(["password", "WHOOP wants your password to sign in (whoop.password)", { secret: "whoop.password", company: "WHOOP", use: "sign-in" }, false]);
    expect(unkept.email.value).toBeUndefined();
  });
});

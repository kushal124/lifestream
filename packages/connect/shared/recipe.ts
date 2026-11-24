import { textHead, type Secrets } from "@lifestreamprotocol/core";
import { connectorName, type Connector } from "../declaration.js";
import { NeedsYou, NotYet } from "../seams.js";
import { recipeSecret } from "./password.js";
import { refuse } from "./refused.js";
import { checkPage, needsOf, StationFailed, type Locator, type Outline, type Tab, type WaitFor } from "./station.js";

/** An element a step acts on, or several ways to find it, of which the first the page shows is used. */
type Target = Locator | readonly Locator[];

/** What one step of a recipe does in its tab. */
type Action =
  | {
    /** Goes to a page. */
    readonly do: "open";
    /** The page's URL, at one of the recipe's origins. */
    readonly url: string;
  }
  | {
    /** Clicks an element. */
    readonly do: "click";
    /** The element it clicks. */
    readonly target: Target;
  }
  | {
    /** Ticks a checkbox, clicking it only when it is not ticked yet. */
    readonly do: "tick";
    /** The checkbox it ticks. */
    readonly target: Target;
  }
  | {
    /** Types a secret into a field. */
    readonly do: "fill";
    /** The field it types into. */
    readonly target: Target;
    /** The name of the secret the station types, one the recipe's `secrets` names. */
    readonly secret: string;
    /** This fill types its secret and no text. */
    readonly text?: never;
  }
  | {
    /** Types text into a field. */
    readonly do: "fill";
    /** The field it types into. */
    readonly target: Target;
    /** The text it types, in which a placeholder is filled from the run's values. */
    readonly text: string;
    /** This fill types its text and no secret. */
    readonly secret?: never;
  }
  | {
    /** Picks an option of a list. */
    readonly do: "select";
    /** The list it picks from. */
    readonly target: Target;
    /** The option it picks. */
    readonly option: string;
  };

/** One step of a recipe: what it does, and what the page shows before and after it. */
type Step = Action & {
  /** The step's name, which a broken run reports and `runSteps` answers when it was the last to run. */
  readonly id: string;
  /** What the page must show before the step runs, waited for up to the step's time. */
  readonly expect?: Target;
  /** What the page must show for the step to run at all, waited for only when the step names its time, the step skipped when it does not show. */
  readonly when?: Target;
  /** What the page shows once the step is done, waited for up to the step's time. */
  readonly then?: WaitFor;
  /** How long the step waits for what it looks for, 15 seconds when absent. */
  readonly ms?: number;
  /** Marks the step that submits a sign-in, only in the recipe a connector's `chrome.signin.recipe` names, after which a page asking for a password means the password was refused. */
  readonly acts?: true;
};

/** Steps the station runs in a page of a site in the person's Chrome, written as data. */
export interface Recipe {
  /** The recipe's name, by which a connector's sign-in names it. */
  readonly name: string;
  /** The recipe's version, which a broken run reports beside its name. */
  readonly version: number;
  /** The site's name as the person knows it, in the words of any need the recipe raises. */
  readonly site: string;
  /** The origins its steps open, the first of which is where the person acts on a need it raises. */
  readonly origins: readonly string[];
  /** The names of the secrets its steps type, in which a placeholder is filled from the run's values. */
  readonly secrets?: readonly string[];
  /** What the site shows while an export asked earlier is still being made, which turns a step that fails into a wait. */
  readonly busy?: Target;
  /** The names of the placeholders its steps and secrets hold, each written `${name}` and filled from the run's values. */
  readonly params?: readonly string[];
  /** Its steps, run in order. */
  readonly steps: readonly Step[];
}

const PAGE_BYTES = 4096;
const HEAD_CHARS = 512;

/** A recipe step the page did not answer as written, which fails the poll with where it broke and what the page showed. */
export class RecipeBroken extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "RecipeBroken";
  }

  constructor(
    /** The name of the recipe that broke. */
    readonly recipe: string,
    /** The version of the recipe that broke. */
    readonly version: number,
    /** The id of the step that broke. */
    readonly step: string,
    /** The station's code for what went wrong, as `NOT_FOUND` or `TIMEOUT`. */
    readonly code: string,
    message: string,
    /** The page as it stood when the step broke, when it could be read. */
    readonly page?: Outline,
  ) {
    super(`recipe ${recipe} v${version} broke at step "${step}": ${code}: ${message}\n${pageLines(page)}`);
    this.name = "RecipeBroken";
  }
}

function pageLines(page: Outline | undefined): string {
  if (page === undefined) return "page not read";
  const head = `page ${page.url} "${page.title ?? ""}"`;
  const kept = [head.length > HEAD_CHARS ? `${textHead(head, HEAD_CHARS - 1)}…` : head];
  const lines = (page.lines ?? "").split("\n").filter((line) => line !== "");
  let bytes = Buffer.byteLength(kept[0] as string) + Buffer.byteLength(`\n… ${lines.length} more lines`);
  let at = 0;
  for (; at < lines.length; at++) {
    const size = 1 + Buffer.byteLength(lines[at] as string);
    if (bytes + size > PAGE_BYTES) break;
    kept.push(lines[at] as string);
    bytes += size;
  }
  if (at < lines.length) kept.push(`… ${lines.length - at} more lines`);
  return kept.join("\n");
}

const STEP_MS = 15_000;
const PAGE_CODES = new Set(["NOT_FOUND", "AMBIGUOUS", "TIMEOUT", "REF_STALE", "PAGE_ERROR"]);

const many = (target: Target): readonly Locator[] => (Array.isArray(target) ? target : [target as Locator]);

export const RECIPE_PARAMETER = /\$\{([a-z_]+)\}/gu;

function fill(text: string, params: Readonly<Record<string, string>>, recipe: Recipe): string {
  return text.replace(RECIPE_PARAMETER, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "" || !(recipe.params ?? []).includes(name)) throw new Error(`recipe ${recipe.name} has no parameter "${name}" given`);
    return value;
  });
}

function bound<T>(value: T, params: Readonly<Record<string, string>>, recipe: Recipe): T {
  if (typeof value === "string") return fill(value, params, recipe) as T;
  if (Array.isArray(value)) return value.map((one: unknown) => bound(one, params, recipe)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, bound(one, params, recipe)])) as T;
  return value;
}

/** How a recipe's steps are run. */
export interface StepOptions {
  /** The values its `{name}` placeholders are filled with. */
  readonly params?: Readonly<Record<string, string>>;
}

/** Runs a recipe's steps in a tab as an ordinary run that never signs in, answering the id of the last step that ran, or null when none did. */
export function runSteps(tab: Tab, recipe: Recipe, options: StepOptions = {}): Promise<string | null> {
  return stepsRun(tab, recipe, options, false);
}

async function stepsRun(tab: Tab, recipe: Recipe, options: StepOptions, signsIn: boolean): Promise<string | null> {
  let last: string | null = null;
  let acted = false;
  const site = recipe.site;
  const secrets = bound(recipe.secrets ?? [], options.params ?? {}, recipe);
  for (const written of recipe.steps) {
    const step = bound(written, options.params ?? {}, recipe);
    const ms = step.ms ?? STEP_MS;
    try {
      const shown = async (target: Target, wait: boolean): Promise<Locator | null> => {
        const choices = many(target);
        const first = async (): Promise<Locator | null> => {
          for (const locator of choices) if ((await tab.find(locator)).length > 0) return locator;
          return null;
        };
        const now = await first();
        if (now !== null || !wait) return now;
        await tab.wait({ any: choices }, ms);
        return first();
      };
      const skip = (error: unknown): null => {
        if (error instanceof StationFailed && PAGE_CODES.has(error.code)) return null;
        throw error;
      };
      if (step.when !== undefined && (await shown(step.when, step.ms !== undefined).catch(skip)) === null) continue;
      if (step.expect !== undefined && (await shown(step.expect, true)) === null) throw new StationFailed("TIMEOUT", "the page never showed what the step expects");
      if (step.do === "open") {
        const url = new URL(step.url);
        if (!recipe.origins.includes(url.origin)) throw new Error(`recipe ${recipe.name} opens ${url.origin}, which is not one of its origins`);
        await tab.goto(step.url);
      } else {
        const target = await shown(step.target, true);
        if (target === null) throw new StationFailed("NOT_FOUND", "the page never showed the step's target");
        if (step.do === "click") await tab.click(target);
        if (step.do === "tick" && (await tab.find(target))[0]?.checked !== true) await tab.click(target);
        if (step.do === "select") await tab.select(target, step.option);
        if (step.do === "fill" && step.secret !== undefined) {
          if (!secrets.includes(step.secret)) throw new Error(`recipe ${recipe.name} fills ${step.secret}, which it does not name`);
          await tab.fill(target, { secret: step.secret });
        }
        if (step.do === "fill" && step.text !== undefined) await tab.fill(target, step.text);
      }
      if (step.acts === true) acted = true;
      if (step.then !== undefined) await tab.wait(step.then, ms);
      last = step.id;
    } catch (error) {
      if (!(error instanceof StationFailed)) throw error;
      if (error.code === "SECRET_REFUSED") {
        throw new NeedsYou("password", `${site} asks for a password Lifestream doesn't have. Sign in to ${site} in Chrome.`, { at: { site: new URL(recipe.origins[0] as string).host } });
      }
      if (!PAGE_CODES.has(error.code)) throw error;
      const page = error.snapshot ?? (await tab.snapshot().catch(() => undefined));
      const needs = needsOf(page?.signals, site, { site: new URL(recipe.origins[0] as string).host, errand: tab.errand });
      if (needs !== null && !(signsIn && !acted && needs.reason === "password")) throw needs;
      if (recipe.busy !== undefined && (await showing(tab, recipe.busy))) throw new NotYet("provider-making", `${site} shows an export asked earlier still being made`, { facts: { step: "making" } });
      throw new RecipeBroken(recipe.name, recipe.version, step.id, error.code, error.message, page);
    }
  }
  return last;
}

async function showing(tab: Tab, target: Target): Promise<boolean> {
  for (const locator of many(target)) if ((await tab.find(locator).catch(() => [])).length > 0) return true;
  return false;
}

/** A connector's recipes, each under the name its sign-in finds it by. */
export type Recipes = Readonly<Record<string, Recipe>>;

function signInRecipe(connector: Connector, recipes: Recipes): Recipe | undefined {
  const declared = connector.chrome?.signin?.recipe;
  return declared === undefined ? undefined : recipes[declared];
}

export function signInParams(connector: Connector, recipes: Recipes, block: object): Readonly<Record<string, string>> {
  const values = block as Readonly<Record<string, unknown>>;
  const given: Record<string, string> = {};
  for (const name of signInRecipe(connector, recipes)?.params ?? []) {
    const value = values[name];
    if (typeof value !== "string" || value === "") refuse(`the block names no ${name}, which ${connectorName(connector)}'s sign-in asks for`);
    given[name] = value;
  }
  return given;
}

export function signInSecrets(connector: Connector, recipes: Recipes, params: Readonly<Record<string, string>>): readonly string[] {
  const recipe = signInRecipe(connector, recipes);
  return recipe === undefined ? [] : bound(recipe.secrets ?? [], params, recipe);
}

export async function signInAgain(tab: Tab, connector: Connector, given: { readonly params: Readonly<Record<string, string>>; readonly secrets: Pick<Secrets, "get">; readonly recipes: Recipes }): Promise<void> {
  const chrome = connector.chrome;
  if (chrome === undefined) throw new Error(`${connector.id} is no site read in Chrome`);
  const name = connectorName(connector);
  const signin = chrome.signin;
  const recipe = signInRecipe(connector, given.recipes);
  if (recipe !== undefined && new URL((await tab.snapshot()).url).origin === signin!.origin) {
    const secrets = bound(recipe.secrets ?? [], given.params, recipe);
    for (const each of secrets) recipeSecret(given.secrets, each, name, "sign-in");
    try {
      await stepsRun(tab, recipe, { params: given.params }, true);
    } catch (error) {
      if (!(error instanceof NeedsYou && error.reason === "password")) throw error;
      const secret = secrets[0];
      throw new NeedsYou("password", `${name} asks for your password again${secret === undefined ? "" : ` (${secret})`}`, {
        at: { site: new URL(signin!.origin).host }, facts: { ...(secret === undefined ? {} : { secret }), company: name, use: "sign-in" },
      });
    }
  }
  await checkPage(tab, name, new URL(chrome.origin).host);
}

import { PAGE_FILE_BYTES, SECRET, type Code, type Found, type FromCookie, type Locator, type Outline, type Signals, type WaitFor } from "./wire.js";


export type PageOp =
  | { readonly op: "snapshot"; readonly text?: boolean }
  | { readonly op: "find"; readonly target: Locator }
  | { readonly op: "click"; readonly target: Locator }
  | { readonly op: "fill"; readonly target: Locator; readonly value: string }
  | { readonly op: "select"; readonly target: Locator; readonly option: string }
  | { readonly op: "probe"; readonly for: WaitFor }
  | {
      readonly op: "fetch";
      readonly url: string;
      readonly method: "GET" | "POST";
      readonly headers: Readonly<Record<string, string | FromCookie>>;
      readonly body?: string;
      readonly binary: boolean;
      readonly held: boolean;
      readonly ms: number;
    };

export type PageCall = PageOp & {
  readonly origins: readonly string[];
  readonly withhold: { readonly values: readonly string[]; readonly cookies: readonly string[] };
};

export interface PageAnswers {
  snapshot: Outline;
  find: Found[];
  click: Record<string, never>;
  fill: { filled: true };
  select: { selected: string };
  probe: { matched: boolean; outline?: Outline };
  fetch: { status: number; url: string; text?: string; base64?: string; error?: { code: "PAGE_ERROR" | "TOO_LARGE"; message: string } };
}

export type PageEnvelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: Code; readonly message: string } };

export interface PageAgent {
  run(call: PageCall): Promise<PageEnvelope>;
}

type Win = Window & typeof globalThis;

const MAX_LINES = 400;
const MAX_TEXT = 20_000;
const MAX_NAME = 120;

const OUTLINED = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
  "slider", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "heading", "dialog",
  "alert", "spinbutton",
]);
const CAPTCHA_FRAME = /challenges\.cloudflare\.com|recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha/iu;
const CAPTCHA_TITLE = /just a moment|attention required|verify you are human/iu;
const CAPTCHA_ELEMENT = ".cf-turnstile, .g-recaptcha, .h-captcha, #challenge-form";
const OTP_NAME = /\botp\b|one[\s-]?time|verification code/iu;
const VERIFY_TEXT = /verify (it'?s|that it'?s) you|verify yourself|verify your identity|two[\s-]?(step|factor)|2fa|approve (this|the) (sign[\s-]?in|login)|confirm it'?s you/iu;
const HEADING = /^(H[1-6]|DIALOG)$/u;

export const REPEATS = "the answer repeats a value the errand holds";

const hidden = (text: string, values: readonly string[]): string => values.reduce((said, value) => said.replaceAll(value, SECRET), text);

export function repeats(text: string, values: readonly string[]): boolean {
  const holds = (each: string): boolean => values.some((value) => each.includes(value));
  if (values.length === 0) return false;
  if (holds(text)) return true;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  const strings = (node: unknown): string[] => typeof node === "string" ? [node]
    : Array.isArray(node) ? node.flatMap(strings)
    : node !== null && typeof node === "object" ? Object.entries(node).flatMap(([key, inner]) => [key, ...strings(inner)]) : [];
  return strings(json).some(holds);
}

class PageError extends Error {
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message);
  }
}

export function createPageAgent(win: Win): PageAgent {
  const doc = win.document;
  const token = Math.random().toString(16).slice(2, 8);
  const refs = new Map<string, WeakRef<Element>>();
  const refOf = new WeakMap<Element, string>();
  let next = 1;
  let withholding: readonly string[] = [];
  const said = (text: string | null | undefined): string => hidden(text ?? "", withholding);

  const mint = (element: Element): string => {
    const known = refOf.get(element);
    if (known !== undefined) return known;
    const ref = `${token}:e${next++}`;
    refs.set(ref, new WeakRef(element));
    refOf.set(element, ref);
    return ref;
  };

  function* elements(root: ParentNode = doc.body ?? doc.documentElement): Generator<Element> {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      yield element;
      if (element.shadowRoot !== null) yield* elements(element.shadowRoot);
    }
  }

  const hasLayout = (): boolean => doc.documentElement.getBoundingClientRect().height > 0;

  const visible = (element: Element): boolean => {
    if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
    if (hasLayout() && typeof element.checkVisibility === "function") {
      return element.checkVisibility({ visibilityProperty: true });
    }
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return !(element instanceof win.HTMLInputElement && element.type === "hidden");
  };

  const plain = (text: string | null | undefined): string => (text ?? "").replace(/\s+/gu, " ").trim();
  const squash = (text: string | null | undefined): string => plain(said(text));
  type Read = (text: string | null | undefined) => string;
  const cut = (text: string, at = MAX_NAME): string => (text.length > at ? `${text.slice(0, at - 1)}…` : text);

  function roleOf(element: Element, read: Read = squash): string | null {
    const explicit = element.getAttribute("role");
    if (explicit !== null && explicit.trim() !== "") return read(explicit).split(" ")[0] ?? null;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return element.hasAttribute("href") ? "link" : null;
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") {
      const select = element as HTMLSelectElement;
      return select.multiple || select.size > 1 ? "listbox" : "combobox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "dialog") return "dialog";
    if (/^h[1-6]$/u.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    return null;
  }

  function labelsOf(element: Element, read: Read = squash): string {
    const labelled = element.getAttribute("aria-labelledby");
    if (labelled !== null) {
      const text = labelled.split(/\s+/u).map((id) => read(doc.getElementById(id)?.textContent)).join(" ");
      if (text.trim() !== "") return read(text);
    }
    const aria = element.getAttribute("aria-label");
    if (aria !== null && aria.trim() !== "") return read(aria);
    if ("labels" in element) {
      const labels = Array.from((element as HTMLInputElement).labels ?? []);
      const text = read(labels.map((label) => label.textContent).join(" "));
      if (text !== "") return text;
    }
    return "";
  }

  function nameOf(element: Element, read: Read): string {
    const labelled = labelsOf(element, read);
    if (labelled !== "") return labelled;
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const input = element as HTMLInputElement;
      const type = (input.getAttribute("type") ?? "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return read(input.value);
      const hint = input.getAttribute("placeholder") ?? input.getAttribute("title") ?? input.getAttribute("name");
      return read(hint);
    }
    if (tag === "img") return read(element.getAttribute("alt"));
    const text = read(element.textContent);
    return text !== "" ? text : read(element.getAttribute("title"));
  }

  const answeredName = (element: Element): string => cut(nameOf(element, squash));
  const answeredRole = (element: Element): string => roleOf(element) ?? said(element.tagName.toLowerCase());

  const isPassword = (element: Element): boolean => element instanceof win.HTMLInputElement && element.type === "password";

  function describe(element: Element, role: string): string {
    const parts = [`[${mint(element)}] ${role} "${answeredName(element).replaceAll('"', "'")}"`];
    if (element instanceof win.HTMLInputElement || element instanceof win.HTMLTextAreaElement) {
      if (role === "checkbox" || role === "radio") {
        parts.push((element as HTMLInputElement).checked ? "checked" : "unchecked");
      } else if (element.value !== "") {
        parts.push(`value="${isPassword(element) ? SECRET : cut(said(element.value), 60)}"`);
      }
      if (element.disabled) parts.push("disabled");
    } else if (element instanceof win.HTMLSelectElement) {
      const options = Array.from(element.options).map((option) => squash(option.label || option.text));
      const selected = element.selectedOptions[0];
      if (selected !== undefined) parts.push(`value="${squash(selected.label || selected.text)}"`);
      parts.push(`options=[${options.slice(0, 20).join(" | ")}${options.length > 20 ? " | …" : ""}]`);
      if (element.disabled) parts.push("disabled");
    } else if (element instanceof win.HTMLButtonElement && element.disabled) {
      parts.push("disabled");
    } else if (role === "heading") {
      const aria = element.getAttribute("aria-level");
      const level = /^h([1-6])$/iu.exec(element.tagName)?.[1] ?? (aria === null ? null : squash(aria));
      if (level !== null && level !== undefined) parts.push(`level=${level}`);
    } else if (role === "link") {
      const href = element.getAttribute("href") ?? "";
      if (href !== "" && !href.startsWith("javascript:")) parts.push(`-> ${cut(said(href), 80)}`);
    }
    const checked = element.getAttribute("aria-checked") ?? element.getAttribute("aria-selected");
    if (checked !== null && !(element instanceof win.HTMLInputElement)) parts.push(`${checked === "true" ? "checked" : "unchecked"}`);
    if (element.getAttribute("aria-disabled") === "true") parts.push("disabled");
    return parts.join(" ");
  }

  function signals(): Signals {
    let captcha = CAPTCHA_TITLE.test(doc.title);
    let otp = false;
    let password = false;
    let verify = false;
    for (const element of elements()) {
      if (element instanceof win.HTMLIFrameElement) {
        captcha ||= CAPTCHA_FRAME.test(element.getAttribute("src") ?? "");
      } else if (element instanceof win.HTMLInputElement) {
        if (!visible(element)) continue;
        if (element.type === "password") password = true;
        const hint = `${element.name} ${element.id} ${labelsOf(element, plain)} ${element.getAttribute("placeholder") ?? ""}`;
        if (element.getAttribute("autocomplete") === "one-time-code" || OTP_NAME.test(hint)) otp = true;
      } else if (HEADING.test(element.tagName) || ["dialog", "alertdialog", "heading"].includes(element.getAttribute("role") ?? "")) {
        verify ||= visible(element) && VERIFY_TEXT.test(plain(element.textContent));
      }
      captcha ||= element.matches(CAPTCHA_ELEMENT);
    }
    return { captcha, otp, password, verify };
  }

  function outline(text: boolean): Outline {
    const lines: string[] = [];
    for (const element of elements()) {
      if (lines.length >= MAX_LINES) {
        lines.push("… (outline cut)");
        break;
      }
      const role = roleOf(element);
      if (role === null || !OUTLINED.has(role) || !visible(element)) continue;
      lines.push(describe(element, role));
    }
    const base = { url: said(win.location.href), title: said(doc.title), lines: lines.join("\n"), signals: signals() };
    if (!text) return base;
    const body = squash((doc.body as HTMLElement | null)?.innerText ?? doc.body?.textContent ?? "");
    return { ...base, text: cut(body, MAX_TEXT) };
  }

  const matchesName = (actual: string, wanted: string | undefined, exact: boolean | undefined): boolean =>
    wanted === undefined || (exact === true ? actual === wanted : actual.toLowerCase().includes(wanted.toLowerCase()));

  function resolve(target: Locator): Element[] {
    if ("ref" in target) {
      const [owner] = target.ref.split(":");
      const element = refs.get(target.ref)?.deref();
      if (owner !== token || element === undefined || !element.isConnected) {
        throw new PageError("REF_STALE", `ref ${target.ref} belongs to a page that is gone; read the page again`);
      }
      return [element];
    }
    const found: Element[] = [];
    if ("css" in target) {
      for (const element of Array.from(doc.querySelectorAll(target.css))) if (visible(element)) found.push(element);
      return found;
    }
    for (const element of elements()) {
      if ("role" in target) {
        if (roleOf(element, plain) === target.role && matchesName(nameOf(element, plain), target.name, target.exact) && visible(element)) {
          found.push(element);
        }
      } else if ("label" in target) {
        const role = roleOf(element, plain);
        if (role !== null && ["textbox", "searchbox", "combobox", "checkbox", "radio", "spinbutton", "listbox", "slider", "switch"].includes(role)
          && matchesName(nameOf(element, plain), target.label, false) && visible(element)) {
          found.push(element);
        }
      } else if ("text" in target) {
        const own = plain(element.textContent).toLowerCase();
        if (!own.includes(target.text.toLowerCase()) || !visible(element)) continue;
        for (let index = found.length - 1; index >= 0; index--) {
          if (found[index]?.contains(element)) found.splice(index, 1);
        }
        found.push(element);
      }
    }
    return found;
  }

  function one(target: Locator): Element {
    const found = resolve(target);
    if (found.length === 0) throw new PageError("NOT_FOUND", `nothing on the page matches ${JSON.stringify(target)}`);
    if (found.length > 1) {
      const sample = found.slice(0, 5).map((element) => describe(element, answeredRole(element)));
      throw new PageError("AMBIGUOUS", `${found.length} elements match ${JSON.stringify(target)}: ${sample.join("; ")}`);
    }
    return found[0] as Element;
  }

  function probe(wanted: WaitFor): boolean {
    if ("url" in wanted) return new RegExp(wanted.url, "u").test(win.location.href);
    if ("any" in wanted) return wanted.any.some((one) => resolve(one).length > 0);
    if ("gone" in wanted) {
      try {
        return resolve(wanted.gone).length === 0;
      } catch (error) {
        if (error instanceof PageError && error.code === "REF_STALE") return true;
        throw error;
      }
    }
    return resolve(wanted).length > 0;
  }

  function click(element: Element): PageAnswers["click"] {
    if ((element as HTMLButtonElement).disabled === true) throw new PageError("PAGE_ERROR", "the element is disabled");
    element.scrollIntoView?.({ block: "center", inline: "center" });
    const init = { bubbles: true, cancelable: true, composed: true, view: win, button: 0 };
    if (element instanceof win.HTMLElement) element.focus?.();
    element.dispatchEvent(new win.MouseEvent("mousedown", init));
    element.dispatchEvent(new win.MouseEvent("mouseup", init));
    if (element instanceof win.HTMLElement) element.click();
    else element.dispatchEvent(new win.MouseEvent("click", init));
    return {};
  }

  function fill(element: Element, value: string): void {
    if (element instanceof win.HTMLSelectElement) throw new PageError("PAGE_ERROR", "a select is chosen with `select`, not filled");
    if (element instanceof win.HTMLInputElement || element instanceof win.HTMLTextAreaElement) {
      if (element.disabled || element.readOnly) throw new PageError("PAGE_ERROR", "the field is disabled or read-only");
      element.focus();
      const prototype = element instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      element.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new win.Event("change", { bubbles: true }));
      return;
    }
    if (element instanceof win.HTMLElement && element.isContentEditable) {
      element.focus();
      element.textContent = value;
      element.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
      return;
    }
    throw new PageError("PAGE_ERROR", "the element takes no text");
  }

  function select(element: Element, wanted: string): string {
    if (!(element instanceof win.HTMLSelectElement)) throw new PageError("PAGE_ERROR", "only a <select> is chosen with `select`; click the option instead");
    const option = Array.from(element.options).find(
      (candidate) => plain(candidate.label || candidate.text) === wanted || candidate.value === wanted,
    );
    if (option === undefined) throw new PageError("NOT_FOUND", `the select has no option "${wanted}"`);
    element.value = option.value;
    element.dispatchEvent(new win.Event("input", { bubbles: true }));
    element.dispatchEvent(new win.Event("change", { bubbles: true }));
    return squash(option.label || option.text);
  }

  function binary(bytes: Uint8Array): string {
    let text = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return text;
  }

  function cookie(name: string): string | undefined {
    for (const pair of doc.cookie.split(";")) {
      const at = pair.indexOf("=");
      if (at < 0 || pair.slice(0, at).trim() !== name) continue;
      const value = pair.slice(at + 1).trim();
      return value === "" ? undefined : value;
    }
    return undefined;
  }

  function act(call: Exclude<PageOp, { op: "fetch" }>): unknown {
    switch (call.op) {
      case "snapshot":
        return outline(call.text === true);
      case "find":
        return resolve(call.target).map((element): Found => {
          const role = answeredRole(element);
          const base = { ref: mint(element), role, name: answeredName(element) };
          if (element instanceof win.HTMLInputElement && (role === "checkbox" || role === "radio")) return { ...base, checked: element.checked };
          if (element instanceof win.HTMLInputElement || element instanceof win.HTMLTextAreaElement || element instanceof win.HTMLSelectElement) {
            return { ...base, value: isPassword(element) ? SECRET : said(element.value) };
          }
          return base;
        });
      case "click":
        return click(one(call.target));
      case "fill":
        fill(one(call.target), call.value);
        return { filled: true };
      case "select":
        return { selected: select(one(call.target), call.option) };
      case "probe": {
        const matched = probe(call.for);
        return matched ? { matched, outline: outline(false) } : { matched };
      }
    }
  }

  async function request(call: Extract<PageOp, { op: "fetch" }>, values: readonly string[]): Promise<PageAnswers["fetch"]> {
    const alone = (code: "PAGE_ERROR" | "TOO_LARGE", message: string): PageAnswers["fetch"] => ({ status: 0, url: call.url, error: { code, message: hidden(message, values) } });
    const tooLarge = () => alone("TOO_LARGE", `the body is over ${PAGE_FILE_BYTES} bytes`);
    const refused = () => alone("PAGE_ERROR", REPEATS);
    const headers: Record<string, string> = {};
    const sent = [...values];
    for (const [key, value] of Object.entries(call.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
        continue;
      }
      const kept = cookie(value.cookie);
      if (kept === undefined) continue;
      headers[key] = `${value.prefix ?? ""}${kept}`;
      sent.push(kept);
    }
    const giving = new AbortController();
    const bound = setTimeout(() => giving.abort(), call.ms);
    const init: RequestInit = { method: call.method, headers, credentials: "same-origin", signal: giving.signal };
    if (call.body !== undefined) init.body = call.body;
    try {
      const response = await win.fetch(call.url, init);
      if (repeats(response.url, sent)) return refused();
      if (!call.binary) {
        const text = await response.text();
        return !call.held && repeats(text, sent) ? refused() : { status: response.status, url: response.url, text };
      }
      if (Number(response.headers.get("content-length") ?? 0) > PAGE_FILE_BYTES) return tooLarge();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > PAGE_FILE_BYTES) return tooLarge();
      const encoded = bytes as Uint8Array & { toBase64?: () => string };
      const nodeBuffer = (globalThis as { Buffer?: { from(value: ArrayBufferLike, offset: number, length: number): { toString(encoding: string): string } } }).Buffer;
      const base64 = typeof encoded.toBase64 === "function"
        ? encoded.toBase64()
        : nodeBuffer !== undefined
          ? nodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
          : win.btoa(binary(bytes));
      return repeats(new TextDecoder().decode(bytes), sent) ? refused() : { status: response.status, url: response.url, base64 };
    } catch (error) {
      if (giving.signal.aborted) return alone("PAGE_ERROR", `the site did not answer within ${call.ms / 1000} s`);
      return alone("PAGE_ERROR", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(bound);
    }
  }

  return {
    async run(call) {
      if (!call.origins.includes(win.location.origin)) return { ok: false, error: { code: "ORIGIN_REFUSED", message: "the page left the errand's origins under the call" } };
      const values = [...call.withhold.values, ...call.withhold.cookies.map(cookie)]
        .filter((value): value is string => value !== undefined && value !== "")
        .sort((a, b) => b.length - a.length);
      if (call.op === "fetch") return { ok: true, value: await request(call, values) };
      withholding = values;
      try {
        return { ok: true, value: act(call) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { code: error instanceof PageError ? error.code : "PAGE_ERROR", message: hidden(message, values) } };
      } finally {
        withholding = [];
      }
    },
  };
}

import { randomBytes } from "node:crypto";
import type { Site } from "./fixture-browser.js";


export const CUSTOMER_ID = "CID-55500001";
export const PASSWORD = "pw-fixture-9!x";
export const SESSION_TOKEN = "tok-held-7f3a91";
export const LONG_SECRET = `sec-${"9a7c".repeat(21)}xy`;
export const API_KEY = "key-fixture-3b8e";
export const EXPORT = randomBytes(8 * 1024 * 1024 + 1234);

const json = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });

export function chatSite(state: { signedIn: boolean }): Site {
  const conversations = ["c-0001", "c-0002", "c-0003"].map((uuid, index) => ({ uuid, updated_at: `2026-10-0${index + 1}T10:00:00Z` }));
  return {
    origin: "https://chat.example",
    pages: {
      "/": "<title>Chats</title><h1>Recents</h1><a href='/new'>New chat</a>",
    },
    api(request) {
      if (!state.signedIn) return { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
      if (request.path === "/api/organizations") return json([{ uuid: "org-aa01" }]);
      if (request.path === "/api/organizations/org-aa01/chat_conversations") return json(conversations);
      const one = /^\/api\/organizations\/org-aa01\/chat_conversations\/(c-\d{4})\?tree=true$/u.exec(request.path);
      if (one !== null) return json({ uuid: one[1], chat_messages: [{ uuid: `${one[1]}-m1`, text: "hello" }] });
      return undefined;
    },
  };
}

export function tokenSite(): Site {
  let after: () => void = () => undefined;
  const late = new Promise<void>((open) => (after = open));
  return {
    origin: "https://gpt.example",
    pages: {
      "/": "<title>Assistant</title><h1>Assistant</h1><button>Wait</button>",
    },
    api(request) {
      if (request.path === "/api/auth/session") return json({ user: { id: "user-aa01" }, accessToken: SESSION_TOKEN });
      if (request.path.startsWith("/backend-api/conversations")) {
        if (request.headers["authorization"] !== `Bearer ${SESSION_TOKEN}`) return { status: 401, body: "{}" };
        return json({ items: [{ id: "g-0001" }, { id: "g-0002" }], total: 2 });
      }
      if (request.path === "/backend-api/export") {
        return request.headers["authorization"] === `Bearer ${SESSION_TOKEN}` ? { status: 200, body: EXPORT } : { status: 401, body: "{}" };
      }
      if (request.path === "/backend-api/huge") return { status: 200, body: new Uint8Array(33 * 1024 * 1024) };
      if (request.path === "/backend-api/elsewhere") return { status: 200, body: "redirect:https://cdn.example/export" };
      if (request.path === "/backend-api/reset") return { status: 200, body: "reset:" };
      if (request.path === "/backend-api/keyed") return json({ [SESSION_TOKEN]: { id: "g-0001" } });
      if (request.path === "/backend-api/echo-key") return { status: 200, body: new TextEncoder().encode(`key ${request.headers["x-key"] ?? ""} bytes`) };
      if (request.path === "/backend-api/after") {
        after();
        return json({ after: true });
      }
      if (request.path === "/backend-api/late-file") return late.then(() => ({ status: 200, body: new TextEncoder().encode(`late ${SESSION_TOKEN} bytes`) }));
      if (request.path === "/backend-api/late-json") return late.then(() => json({ late: SESSION_TOKEN }));
      if (request.path === "/backend-api/late-plain") return late.then(() => json({ late: true }));
      return undefined;
    },
  };
}

export function bankSite(log: { values: Record<string, string>[] }): Site {
  return {
    origin: "https://bank.example",
    pages: {
      "/login": `<title>NetBanking</title>
        <form action="/login">
          <label for="cid">Customer ID</label><input id="cid" name="cid">
          <label for="pw">Password</label><input id="pw" name="pw" type="password">
          <button type="submit">Login</button>
        </form>`,
      "/login?error": `<title>NetBanking</title><p role="alert">Invalid credentials</p>`,
      "/dashboard": `<title>Dashboard</title><h1>Welcome ${CUSTOMER_ID}</h1>
        <a href="/statement">Account Statement</a>
        <a href="https://evil.example/offer">Offers</a>
        <button>Go</button><button>Go</button>
        <label for="ref">Reference</label><input id="ref" value="${CUSTOMER_ID}">`,
      "/statement": `<title>Statement</title><h2>Account Statement</h2>
        <select aria-label="Period"><option>Last month</option><option>Custom Date</option></select>
        <label><input type="radio" name="format" value="pdf" checked> PDF</label>
        <label><input type="radio" name="format" value="txt"> Text</label>
        <button>Download</button>`,
      "/verify": `<title>Sign in</title><h2>Verify It's You</h2><button>App Notification Send Now</button><button>Cancel</button>`,
      "/otp-shadow": `<title>Sign in</title><h2>Please verify yourself</h2>
        <otp-box data-shadow><input type="password" placeholder="Enter OTP"></otp-box>`,
      "/otp": `<title>Verify</title><label for="otp">Enter OTP</label><input id="otp" autocomplete="one-time-code">`,
      "/challenge": `<title>Just a moment...</title><iframe src="https://challenges.cloudflare.com/turnstile/v0"></iframe>`,
    },
    submit(path, values) {
      log.values.push({ ...values });
      if (path === "/login") return values["cid"] === CUSTOMER_ID && values["pw"] === PASSWORD ? "/dashboard" : "/login?error";
      return path;
    },
  };
}

export const SESSION_COOKIE = "app-auth-token";
export const COOKIE_TOKEN = "ck-session-5e1d07a9";
export const LONG_COOKIE_TOKEN = `ck-long-${"5e1d07a9".repeat(24)}`;
export const APP = "https://app.session.example";
export const API = "https://api.session.example";

const ESCAPED = `\\u${COOKIE_TOKEN.charCodeAt(0).toString(16).padStart(4, "0")}${COOKIE_TOKEN.slice(1)}`;

export function sessionSites(seen: (string | null)[]): [Site, Site] {
  const app: Site = {
    origin: APP,
    pages: {
      "/": "<title>Today</title><h1>Today</h1><p>Recovery</p>", "/account": `<title>Account</title><h1>Session ${COOKIE_TOKEN}</h1><p>Signed in</p>`,
      "/long-account": `<title>Account</title><h1>Session ${LONG_COOKIE_TOKEN}</h1><p>Signed in</p>`,
    },
  };
  const api: Site = {
    origin: API,
    pages: { "/": "<title>API</title><h1>API</h1>" },
    cors: [APP],
    api(request) {
      const bearer = request.headers["authorization"] ?? null;
      seen.push(bearer);
      if (request.path === "/v1/refused-echo") return { status: 401, body: JSON.stringify({ error: "expired", token: bearer }) };
      if (bearer === `Bearer ${LONG_COOKIE_TOKEN}` && request.path === "/v1/me") return json({ user: { id: 10000001 }, account: { email: "person-a@example.com" } });
      if (bearer !== `Bearer ${COOKIE_TOKEN}`) return { status: 401, body: "{}" };
      if (request.path === "/v1/me") return json({ user: { id: 10000001 }, account: { email: "person-a@example.com" } });
      if (request.path === "/v1/cycles") return { status: 200, body: new TextEncoder().encode(JSON.stringify({ records: [{ id: 1, user_id: 10000001 }] })) };
      if (request.path === "/v1/echo") return json({ you: { token: COOKIE_TOKEN } });
      if (request.path === "/v1/away") return { status: 200, body: `redirect:${API}/v1/me?token=${COOKIE_TOKEN}` };
      if (request.path === "/v1/echo-file") return { status: 200, body: new TextEncoder().encode(`\u0000\u0001raw ${COOKIE_TOKEN} bytes`) };
      if (request.path === "/v1/escaped-echo") return { status: 200, body: `{"you":{"token":"${ESCAPED}"}}` };
      if (request.path === "/v1/escaped-echo-file") return { status: 200, body: new TextEncoder().encode(`{"you":{"token":"${ESCAPED}"}}`) };
      return undefined;
    },
  };
  return [app, api];
}

// Server-side Touchgym client.
//
// Generalized from touchgym-integration.md §3 (multi-hop login + dynamic app
// origin), §4 (read memo), §5 (form-preserving write). This module is the
// ONLY thing in TouchGPT that POSTs the member form, which keeps us compliant
// with the doc's "single writer" rule (§6) and avoids wiping member data (§5.1).

const LOGIN_ENTRY = "https://touchgym.co.kr/m/login.php";
const LOGIN_POST = "https://www.touchgym.co.kr/m/login.php?q=w&URL=";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface TouchgymCreds {
  clubId: string;
  loginId: string;
  password: string;
}

export interface TouchgymSession {
  appOrigin: string;
  sid: string;
}

/** Thrown when the cached session is no longer valid (member GET redirected to
 *  login, or HTML lacks the memo field). Triggers a one-shot re-login. */
export class SessionExpiredError extends Error {}

// ---------------------------------------------------------------------------
// Cookie jar + manual-redirect fetch (doc §3.3 / §3.4, ported near-verbatim).
// ---------------------------------------------------------------------------

type CookieJar = Map<string /*host*/, Map<string /*name*/, string /*value*/>>;

function getSetCookies(h: Headers): string[] {
  const fn = (h as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof fn === "function") return fn.call(h);
  const one = h.get("set-cookie");
  return one ? [one] : [];
}

function storeCookies(jar: CookieJar, reqHost: string, h: Headers) {
  for (const raw of getSetCookies(h)) {
    const first = raw.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const dom = raw.match(/domain=([^;]+)/i);
    const host = dom ? dom[1]!.trim().replace(/^\./, "") : reqHost;
    (jar.get(host) ?? jar.set(host, new Map()).get(host)!).set(name, value);
  }
}

function cookieHeaderFor(jar: CookieJar, host: string): string {
  const out: string[] = [];
  for (const [h, cookies] of jar)
    if (host === h || host.endsWith("." + h))
      for (const [n, v] of cookies) out.push(`${n}=${v}`);
  return out.join("; ");
}

async function fetchWithJar(
  jar: CookieJar,
  startUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  maxRedirects = 6,
): Promise<{ res: Response; url: string }> {
  let url = startUrl;
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const host = new URL(url).host;
    const headers: Record<string, string> = { "user-agent": UA, ...(init.headers ?? {}) };
    const cookie = cookieHeaderFor(jar, host);
    if (cookie) headers["cookie"] = cookie;
    const res = await fetch(url, { method, headers, body, redirect: "manual" });
    storeCookies(jar, host, res.headers);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.arrayBuffer().catch(() => {}); // release the socket
      if (!loc) return { res, url };
      url = new URL(loc, url).toString();
      method = "GET"; // browsers downgrade to GET after a 3xx
      body = undefined;
      continue;
    }
    return { res, url };
  }
  throw new Error("redirect limit exceeded");
}

// ---------------------------------------------------------------------------
// Login (doc §3.4) — multi-hop, discovers the dynamic app origin (wN host).
// ---------------------------------------------------------------------------

export async function touchgymLogin(creds: TouchgymCreds): Promise<TouchgymSession> {
  const jar: CookieJar = new Map();
  const entry = `${LOGIN_ENTRY}?club_id=${encodeURIComponent(creds.clubId)}`;
  await fetchWithJar(jar, entry); // ① initial session

  const body = new URLSearchParams();
  body.set("club_id", creds.clubId); // NB: field names are club_id/userid/passwd
  body.set("userid", creds.loginId);
  body.set("passwd", creds.password);
  const { url: finalUrl } = await fetchWithJar(jar, LOGIN_POST, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: entry },
    body: body.toString(),
  });

  if (/\/login\.php/i.test(finalUrl))
    throw new Error("touchgym login failed — check clubId/userid/passwd");

  const appHost = new URL(finalUrl).host; // dynamic app origin (e.g. w3 for grd2)
  const sid = jar.get(appHost)?.get("PHPSESSID");
  if (!sid) throw new Error("touchgym login: no PHPSESSID issued for app host");
  return { appOrigin: `https://${appHost}`, sid };
}

// ---------------------------------------------------------------------------
// Read (doc §4)
// ---------------------------------------------------------------------------

/** GET the member edit form. Throws SessionExpiredError if the session looks dead. */
export async function readMemberHtml(s: TouchgymSession, seq: string): Promise<string> {
  const url = `${s.appOrigin}/m/member/minfo.php?qa=1&seq=${encodeURIComponent(seq)}`;
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      "user-agent": UA,
      cookie: `PHPSESSID=${s.sid}`,
      referer: `${s.appOrigin}/m/member/`,
    },
  });
  if (res.status >= 300 && res.status < 400) {
    await res.arrayBuffer().catch(() => {});
    throw new SessionExpiredError("member GET redirected (session expired)");
  }
  const html = await res.text();
  if (!/name="memo"/i.test(html)) throw new SessionExpiredError("member HTML has no memo field");
  return html;
}

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&"); // &amp; must be last
}

export function extractMemo(html: string): string {
  const m = html.match(/<textarea[^>]*name="memo"[^>]*>([\s\S]*?)<\/textarea>/i);
  return m ? decodeHtmlEntities(m[1] ?? "") : "";
}

// ---------------------------------------------------------------------------
// Write (doc §5) — form-preserving read-modify-write. Send EVERY submittable
// field back, replacing only `memo`, or member data gets nulled out (§5.1).
// ---------------------------------------------------------------------------

function getAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : undefined;
}

export function extractFormFields(html: string): Record<string, string> {
  const form = html.match(/<form name="form"[\s\S]*?<\/form>/i);
  const scope = form ? form[0] : html;
  const fields: Record<string, string> = {};
  for (const m of scope.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = getAttr(tag, "name");
    if (!name) continue;
    const type = (getAttr(tag, "type") ?? "text").toLowerCase();
    if (["image", "submit", "button", "file", "reset"].includes(type)) continue;
    if (type === "checkbox" || type === "radio") {
      if (/\bchecked\b/i.test(tag)) fields[name] = getAttr(tag, "value") ?? "on";
      continue;
    }
    fields[name] = decodeHtmlEntities(getAttr(tag, "value") ?? "");
  }
  for (const m of scope.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const inner = m[2] ?? "";
    const sel =
      inner.match(/<option[^>]*\bselected\b[^>]*value="([^"]*)"/i) ??
      inner.match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/i);
    fields[m[1]!] = sel ? (sel[1] ?? "") : "";
  }
  return fields;
}

export async function writeMemo(
  s: TouchgymSession,
  seq: string,
  freshHtml: string,
  memo: string,
): Promise<void> {
  const fields = extractFormFields(freshHtml);
  fields["memo"] = memo;
  fields["seq2"] = fields["seq2"] ?? seq;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const res = await fetch(`${s.appOrigin}/m/member/minfo.php?seq=${encodeURIComponent(seq)}&q=w`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "user-agent": UA,
      cookie: `PHPSESSID=${s.sid}`,
      "content-type": "application/x-www-form-urlencoded",
      referer: `${s.appOrigin}/m/member/minfo.php?qa=1&seq=${encodeURIComponent(seq)}`,
    },
    body: body.toString(),
  });
  await res.arrayBuffer().catch(() => {});
  if (res.status >= 400) throw new Error(`memo write failed: HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Session cache + auto re-login on expiry (doc §10-7).
// Module-level cache persists across requests within a Worker isolate.
// ---------------------------------------------------------------------------

let cached: TouchgymSession | null = null;

export async function withSession<T>(
  creds: TouchgymCreds,
  fn: (s: TouchgymSession) => Promise<T>,
): Promise<T> {
  if (!cached) cached = await touchgymLogin(creds);
  try {
    return await fn(cached);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      cached = await touchgymLogin(creds); // one-shot re-login, then retry
      return await fn(cached);
    }
    throw e;
  }
}

/*
 * TouchGPT — browser console client (memo-only; never contacts the worker).
 *
 * Designed for an environment that can reach ONLY touchgym.co.kr. The flow:
 *   ask("질문")  →  write a question line into the member memo (form-preserving)
 *               →  poll the memo every 2s (read-only)
 *               →  the always-on worker writes the answer back into the memo
 *               →  print it here.
 *
 * HOW TO USE
 *   1) Log into Touchgym, open the member page (https://wN.touchgym.co.kr/m/member/...).
 *   2) Set SEQ below to the SAME member seq the worker polls (TOUCHGYM_SEQ).
 *   3) Paste this whole file into the DevTools Console (or load via base64, see install-via-memo.md).
 *   4) ask("오늘 서울 날씨 알려줘")
 */
(() => {
  "use strict";

  // ====== CONFIG ==========================================================
  const SEQ = "5971817"; // mailbox member seq — MUST match the worker's TOUCHGYM_SEQ
  // =======================================================================

  const PREFIX = "TGPT1";
  const APP_ORIGIN = window.location.origin; // current club app host (doc §9)
  const MEMBER_GET = APP_ORIGIN + "/m/member/minfo.php?qa=1&seq=" + encodeURIComponent(SEQ);
  const MEMBER_POST = APP_ORIGIN + "/m/member/minfo.php?seq=" + encodeURIComponent(SEQ) + "&q=w";

  // --- base64url (mirrors src/lib/protocol.ts) ---------------------------
  function b64urlEncode(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function withTimeout(ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, done: () => clearTimeout(t) };
  }

  // --- read the member form (returns parsed document) --------------------
  async function fetchDoc() {
    const to = withTimeout(15000); // hard timeout (doc §7/§9)
    try {
      const res = await fetch(MEMBER_GET, { credentials: "include", signal: to.signal });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (!doc.querySelector('textarea[name="memo"]'))
        throw new Error("memo 필드를 찾지 못함 (로그인/세션 만료?)");
      return doc;
    } finally {
      to.done();
    }
  }

  function memoOf(doc) {
    const ta = doc.querySelector('textarea[name="memo"]');
    return ta ? ta.value : "";
  }

  // --- write a TGPT line (question or command), preserving the whole form
  //     (doc §5.1/§5.3) ----------------------------------------------------
  async function writeLine(kind, text) {
    const doc = await fetchDoc(); // fresh form
    const form = doc.querySelector('form[name="form"]') || doc;
    const fields = {};
    form.querySelectorAll("input").forEach((el) => {
      if (!el.name) return;
      const type = (el.type || "text").toLowerCase();
      if (["image", "submit", "button", "file", "reset"].includes(type)) return;
      if (type === "checkbox" || type === "radio") {
        if (el.checked) fields[el.name] = el.value || "on";
        return;
      }
      fields[el.name] = el.value;
    });
    form.querySelectorAll("select").forEach((el) => {
      if (el.name) fields[el.name] = el.value;
    });
    form.querySelectorAll("textarea").forEach((el) => {
      if (el.name) fields[el.name] = el.value;
    });

    const id = crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(16).slice(2);
    const line = [PREFIX, id, kind, Date.now(), b64urlEncode(text)].join("|");
    const memo = fields["memo"] ? fields["memo"] + "\n" + line : line;
    fields["memo"] = memo;
    fields["seq2"] = fields["seq2"] || SEQ;

    const body = new URLSearchParams();
    for (const k in fields) body.set(k, fields[k]);
    const res = await fetch(MEMBER_POST, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (res.status >= 400) throw new Error("memo 저장 실패: HTTP " + res.status);
    return id;
  }

  // Find the worker's reply line for a given id: kind "a" for a question,
  // "r" for a command. Both carry a JSON {text, citations} payload.
  function findReply(doc, id, kind) {
    for (const raw of memoOf(doc).split(/\r?\n/)) {
      if (!raw.startsWith(PREFIX + "|")) continue;
      const parts = raw.split("|");
      if (parts.length < 5 || parts[1] !== id || parts[2] !== kind) continue;
      try {
        return JSON.parse(b64urlDecode(parts.slice(4).join("|")));
      } catch {
        return null;
      }
    }
    return null;
  }

  // self-chaining poll: one in-flight request at a time (doc §7), 2s cadence
  async function pollReply(id, kind, tries = 90, intervalMs = 2000) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = findReply(await fetchDoc(), id, kind);
        if (r) return r;
      } catch {
        /* transient — retry */
      }
      await sleep(intervalMs);
    }
    return null;
  }

  function printAnswer(question, ans) {
    console.log("%c\n💬 " + question, "font-weight:bold;font-size:13px");
    console.log("%c🤖 " + ans.text, "color:#16a34a;white-space:pre-wrap");
    if (ans.citations && ans.citations.length) {
      console.groupCollapsed("🔗 출처 " + ans.citations.length + "개");
      ans.citations.forEach((c, i) => console.log(`${i + 1}. ${c.title}\n   ${c.url}`));
      console.groupEnd();
    }
  }

  // --- main entrypoint ---------------------------------------------------
  async function ask(question) {
    if (typeof question !== "string" || !question.trim()) {
      console.warn('사용법: ask("질문 내용")');
      return;
    }
    let id;
    try {
      id = await writeLine("q", question);
    } catch (e) {
      console.error("[TouchGPT] 질문 등록 실패:", e);
      return;
    }
    console.log("%c[TouchGPT] 질문 등록 완료. 워커 답변 대기 중…(최대 3분)", "color:#888", question);

    const ans = await pollReply(id, "a");
    if (!ans) {
      console.warn("[TouchGPT] 시간 내 답변이 도착하지 않았어요. 워커(poller)가 실행 중인지 확인하세요.");
      return;
    }
    printAnswer(question, ans);
    return ans;
  }

  // --- model controls (also go through the memo channel) -----------------
  async function sendCommand(command, waitTries) {
    let id;
    try {
      id = await writeLine("c", command);
    } catch (e) {
      console.error("[TouchGPT] 명령 전송 실패:", e);
      return null;
    }
    const r = await pollReply(id, "r", waitTries || 30, 2000);
    if (!r) {
      console.warn("[TouchGPT] 워커 응답이 없습니다 (poller 실행 여부 확인).");
      return null;
    }
    return r;
  }

  async function models() {
    const r = await sendCommand("listmodels");
    if (r) console.log("%c" + r.text, "color:#2563eb;white-space:pre");
    return r && r.text;
  }

  async function setModel(spec) {
    if (typeof spec !== "string" || !spec.trim()) {
      console.warn('사용법: setModel("provider:model")  ·  목록 보기: models()\n' +
        '  예) gemini:gemini-2.5-pro · cf:@cf/moonshotai/kimi-k2.6 · ollama:gpt-oss:120b');
      return;
    }
    console.log("%c[TouchGPT] 모델 변경 요청…", "color:#888", spec);
    const r = await sendCommand("setmodel " + spec.trim());
    if (r) console.log("%c" + r.text, "color:#2563eb;white-space:pre");
    return r && r.text;
  }

  // --- tame the page's SSL heartbeat for long sessions (doc §9) ----------
  (function tameHeartbeat() {
    try {
      if (typeof window.getLog2ssl !== "function") return;
      const orig = window.getLog2ssl;
      let last = 0;
      window.getLog2ssl = function () {
        const now = Date.now();
        if (now - last < 30000) return; // at most once / 30s
        last = now;
        return orig.apply(this, arguments);
      };
      console.log("%c[TouchGPT] getLog2ssl 하트비트 throttle 설치(30s).", "color:#888");
    } catch {
      /* ignore */
    }
  })();

  // --- expose + greet ----------------------------------------------------
  window.ask = ask;
  window.models = models;
  window.setModel = setModel;
  window.touchgpt = { ask, models, setModel, readMemo: async () => memoOf(await fetchDoc()) };
  console.log(
    "%c[TouchGPT] 준비 완료 (memo 채널).\n" +
      '  ask("질문 내용")              — 질문하기\n' +
      "  models()                      — 전체 모델 목록(▶현재, 🔍웹검색)\n" +
      '  setModel("gemini:gemini-2.5-pro")  — 모델 변경 (provider:model)\n' +
      "       provider = gemini · cf · ollama",
    "color:#2563eb;font-weight:bold;white-space:pre",
  );
})();

# Touchgym 연동 기술 보고서 — 회원 페이지를 데이터 전송 채널로 사용하기

> 다른 프로젝트에서 **Touchgym(터치짐) 회원관리 시스템을 백엔드/전송 채널로 활용**하기 위한
> 재사용 가능한 기술 문서. Hyunwoo Talk 코드베이스(`apps/api/src/lib/touchgym.ts`,
> `apps/api/src/poller.ts`, `packages/shared/src/protocol.ts`, `console/hyunwoo-talk.js`)에서
> 검증된 동작을 일반화해 정리했다.
>
> 검증 기준: club `grd2`, 2026-06-21 라이브 사이트 확인.

---

## 0. TL;DR

- Touchgym에는 공개 API가 없다. 대신 **회원관리 웹 폼을 프로그래밍적으로 로그인·조회·수정**해서
  데이터를 주고받는다(= 인증된 세션으로 하는 폼 스크래핑/자동화).
- 데이터를 담는 곳은 회원 상세 폼의 **자유 텍스트 필드 `<textarea name="memo">`**.
  여기에 임의의 문자열(직렬화한 구조체)을 넣고 읽어서 **KV 셀 / 메시지 큐**처럼 쓴다.
- 흐름은 3단계: **① 멀티홉 로그인 → PHPSESSID + 동적 app origin 획득**,
  **② `minfo.php?qa=1&seq=` GET 으로 폼 HTML 읽기 → memo 추출**,
  **③ 폼 전체를 그대로 다시 POST(`minfo.php?seq=&q=w`) 하되 memo만 교체**.
- 핵심 제약 4가지: **(a) 쓰기는 폼 전체를 보존해야 함**(안 하면 회원 데이터가 날아감),
  **(b) 단일 writer 필수**(memo는 read-modify-write라 동시 쓰기 시 유실),
  **(c) memo는 휘발성**(Touchgym이 "어제+오늘"만 보존 → 영구 저장은 별도 DB 필요),
  **(d) app origin은 club마다 다름**(dbinfo 샤드에 따라 `wN.touchgym.co.kr` 달라짐).

---

## 1. 개념 모델: `memo` 필드 = 공유 저장 셀

Touchgym 회원 한 명(`seq`)의 상세 편집 페이지에는 메모용 `textarea`가 있다.
이 필드는 **자유 입력**이고, 로그인된 관리자라면 읽고/쓸 수 있다. 따라서:

```
[내 프로그램 A] ──write──▶  Touchgym member(seq).memo  ◀──read── [내 프로그램 B]
[내 프로그램 A] ──read───▶                              ◀──write─ [내 프로그램 B]
```

- 같은 `seq`를 보는 두 클라이언트는 memo를 통해 데이터를 교환한다(폴링 기반의 느슨한 메시지 버스).
- memo는 단순 문자열이므로 **직접 라인 프로토콜/JSON 등으로 직렬화**해서 넣는다(§8).
- 사람이 실제로 입력한 메모와 공존해야 하므로 **식별 가능한 접두어**를 붙이고
  **내가 만든 라인만 건드린다**(나머지는 보존).

> 일반화: `memo` 외의 다른 폼 필드도 같은 방식으로 읽고 쓸 수 있지만, memo가 길이 여유가 크고
> 사람이 봐도 "메모"라 부작용이 적다. 다른 필드를 데이터로 쓰면 회원 정보를 오염시킬 수 있으니 비권장.

---

## 2. 두 가지 접근 방식

| | **서버 사이드(권장)** | **브라우저 콘솔** |
|---|---|---|
| 위치 | Cloudflare Worker / Node / 임의 서버 | Touchgym 회원 페이지에서 DevTools 콘솔 |
| 인증 | 직접 멀티홉 로그인 + 수동 쿠키 자(cookie jar) | 이미 로그인된 페이지의 세션 쿠키 재사용 |
| 쿠키 | 코드가 `Cookie`/`Set-Cookie` 직접 관리 | 브라우저가 자동(`credentials: "include"`) |
| origin | 로그인 리다이렉트에서 동적 발견 | `window.location.origin` (현재 페이지) |
| CORS | 없음(서버→서버) | 없음(같은 origin에서 호출) |
| 참고 파일 | `apps/api/src/lib/touchgym.ts` | `console/hyunwoo-talk.js` |

> ⚠️ **제3의 웹 origin(예: 내 사이트의 브라우저 JS)에서 Touchgym을 직접 호출하는 것은 불가능하다.**
> Touchgym은 CORS를 허용하지 않고, 크로스 사이트 쿠키도 안 실린다. 반드시 **서버를 경유**하거나
> **Touchgym 페이지 위에서 실행되는 스크립트**여야 한다.

---

## 3. 인증(로그인) — 멀티홉 + 동적 app origin

### 3.1 흐름

```
1) GET  https://touchgym.co.kr/m/login.php?club_id=<clubId>
        → 302 www 로 이동, 초기 PHPSESSID 발급 (Set-Cookie)

2) POST https://www.touchgym.co.kr/m/login.php?q=w&URL=
        body(x-www-form-urlencoded): club_id=<clubId>&userid=<id>&passwd=<pw>
        → 302 https://<wN>.touchgym.co.kr/m/auth.php?authkey=...&dbinfo=...

3) (자동으로 따라감) GET .../m/auth.php?...
        → club 의 "작동하는" PHPSESSID 를 app origin 에 발급
        → 최종 착지: /m/member/notice1.php  (로그인 성공)
        실패 시: /login.php 로 되돌아옴
```

### 3.2 검증된 사실 (그대로 사용)

- **폼 필드 이름**: `club_id`, `userid`, `passwd` — (주의: `id`/`password` 아님)
- **로그인 POST 대상**: `https://www.touchgym.co.kr/m/login.php?q=w&URL=`
- **app origin 은 club 마다 다르다.** `dbinfo` 샤드에 의해 결정됨.
  - 예: `grd2` → `https://w3.touchgym.co.kr`, `dbinfo=14`.
  - 고정 `w2`로 하드코딩하면 안 된다. **리다이렉트 체인의 최종 URL 호스트에서 origin을 발견**해야 함.
  - 사진 업로드 등 일부 기능은 `dbNN.touchgym.co.kr` 호스트에 있음.
- **세션 쿠키 이름**: `PHPSESSID`. 최종적으로 **app origin(wN) 호스트에 발급된 PHPSESSID**가
  회원 조회/수정에 쓰는 "작동하는" 세션이다.
- **User-Agent 스푸핑 필요**: 평범한 브라우저 UA를 보내야 정상 동작
  (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/149 ... Safari/537.36`).

### 3.3 왜 "쿠키 자 + 수동 리다이렉트"가 필요한가

- 로그인이 **여러 서브도메인**(`touchgym.co.kr` → `www` → `wN`)을 넘나들고, 각 홉이 `Set-Cookie`를 한다.
- 자동 리다이렉트(`redirect: "follow"`)에 맡기면 호스트별 쿠키 매칭/도메인 스코프를 제어할 수 없다.
- 그래서 `redirect: "manual"`로 한 홉씩 따라가며 **호스트별 쿠키를 직접 저장/전송**한다.
- 3xx 응답을 따라갈 때 **메서드를 GET으로 바꾸고 body를 비운다**(브라우저의 표준 동작 모사).

### 3.4 최소 구현 (서버 사이드, 표준 `fetch` 기반)

```ts
const LOGIN_ENTRY = "https://touchgym.co.kr/m/login.php";
const LOGIN_POST  = "https://www.touchgym.co.kr/m/login.php?q=w&URL=";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

type CookieJar = Map<string /*host*/, Map<string /*name*/, string /*value*/>>;

function getSetCookies(h: Headers): string[] {
  const fn = (h as any).getSetCookie;            // 런타임이 지원하면 멀티 Set-Cookie
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

async function fetchWithJar(jar: CookieJar, startUrl: string, init: {
  method?: string; headers?: Record<string,string>; body?: string;
} = {}, maxRedirects = 6): Promise<{ res: Response; url: string }> {
  let url = startUrl, method = init.method ?? "GET", body = init.body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const host = new URL(url).host;
    const headers: Record<string,string> = { "user-agent": UA, ...(init.headers ?? {}) };
    const cookie = cookieHeaderFor(jar, host);
    if (cookie) headers["cookie"] = cookie;
    const res = await fetch(url, { method, headers, body, redirect: "manual" });
    storeCookies(jar, host, res.headers);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.arrayBuffer().catch(() => {});   // 소켓 해제
      if (!loc) return { res, url };
      url = new URL(loc, url).toString();
      method = "GET"; body = undefined;          // 3xx 후 GET 전환
      continue;
    }
    return { res, url };
  }
  throw new Error("redirect limit exceeded");
}

export interface TouchgymSession { appOrigin: string; sid: string; }

export async function touchgymLogin(creds: {
  clubId: string; loginId: string; password: string;
}): Promise<TouchgymSession> {
  const jar: CookieJar = new Map();
  const entry = `${LOGIN_ENTRY}?club_id=${encodeURIComponent(creds.clubId)}`;
  await fetchWithJar(jar, entry);                          // ① 초기 세션

  const body = new URLSearchParams();
  body.set("club_id", creds.clubId);
  body.set("userid", creds.loginId);
  body.set("passwd", creds.password);
  const { url: finalUrl } = await fetchWithJar(jar, LOGIN_POST, {   // ②③
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: entry },
    body: body.toString(),
  });

  if (/\/login\.php/i.test(finalUrl))                      // 로그인 실패 = login.php 로 회귀
    throw new Error("login failed — check clubId/id/passwd");

  const appHost = new URL(finalUrl).host;                  // 동적 app origin 발견
  const sid = jar.get(appHost)?.get("PHPSESSID");
  if (!sid) throw new Error("no PHPSESSID issued");
  return { appOrigin: `https://${appHost}`, sid };
}
```

---

## 4. 데이터 읽기 (Read)

### 4.1 엔드포인트

```
GET {appOrigin}/m/member/minfo.php?qa=1&seq=<seq>
Headers:
  cookie:  PHPSESSID=<sid>
  referer: {appOrigin}/m/member/
  user-agent: <browser UA>
```

- 응답은 회원 편집 폼이 들어있는 **HTML 문서 전체**.
- 데이터는 `<textarea name="memo"> ... </textarea>` 안에 들어 있다.
- **세션 만료 감지**:
  - 3xx 리다이렉트가 오면(로그인 페이지로 튕김) 세션 만료로 간주.
  - 혹은 HTML에 `name="memo"`가 없으면 만료/권한 문제로 간주.

### 4.2 memo 추출 + HTML 엔티티 디코딩

```ts
export function extractMemo(html: string): string {
  const m = html.match(/<textarea[^>]*name="memo"[^>]*>([\s\S]*?)<\/textarea>/i);
  return m ? decodeHtmlEntities(m[1] ?? "") : "";
}
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'").replace(/&amp;/g, "&");   // &amp; 는 반드시 마지막
}
```

> 브라우저 콘솔 모드에서는 정규식 대신 `DOMParser`로 파싱해 `textarea.value`를 읽으면
> 엔티티 디코딩이 자동으로 된다(§9).

---

## 5. 데이터 쓰기 (Write) — 폼 보존 read-modify-write

### 5.1 가장 중요한 원칙

회원 수정 엔드포인트는 **폼 전체를 받는다.** 즉 memo만 보내면 나머지 회원 필드(이름, 연락처,
회원권 정보 등)가 **빈 값으로 덮어써진다.** 따라서:

> **반드시 "방금 GET한 폼의 모든 submittable 필드"를 그대로 다시 POST 하되, `memo`만 교체한다.**
> (read-modify-write. 오래된 HTML로 쓰면 그 사이 변경분을 날린다 → 항상 직전에 fresh GET.)

### 5.2 엔드포인트

```
POST {appOrigin}/m/member/minfo.php?seq=<seq>&q=w
Headers:
  cookie:       PHPSESSID=<sid>
  content-type: application/x-www-form-urlencoded
  referer:      {appOrigin}/m/member/minfo.php?qa=1&seq=<seq>
  user-agent:   <browser UA>
Body: <폼의 모든 필드> + memo=<새 값> (+ seq2=<seq> 없으면 보강)
```

- **성공 판정**: 저장은 보통 3xx 리다이렉트로 응답한다. `status < 400`을 성공으로 본다
  (서버 사이드). 브라우저에서는 `res.ok`.

### 5.3 폼 필드 추출 규칙

`<form name="form">` 범위 안의 컨트롤을 모아 다시 전송한다:

- `<input>`:
  - `type`이 `image|submit|button|file|reset` 이면 **제외**(전송 대상 아님).
  - `checkbox`/`radio`는 **`checked`일 때만** `value`(없으면 `"on"`)로 포함.
  - 그 외(text/hidden/...): `value`를 (엔티티 디코딩해서) 포함.
- `<select>`: `selected` 옵션의 `value`(없으면 빈 문자열).
- `memo`를 새 값으로 덮어쓴다.
- `seq2` 필드가 없으면 `seq`로 채운다(터치짐 저장 로직이 요구).

```ts
function getAttr(tag: string, name: string) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : undefined;
}
function extractFormFields(html: string): Record<string,string> {
  const form = html.match(/<form name="form"[\s\S]*?<\/form>/i);
  const scope = form ? form[0] : html;
  const fields: Record<string,string> = {};
  for (const m of scope.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = getAttr(tag, "name"); if (!name) continue;
    const type = (getAttr(tag, "type") ?? "text").toLowerCase();
    if (["image","submit","button","file","reset"].includes(type)) continue;
    if (type === "checkbox" || type === "radio") {
      if (/\bchecked\b/i.test(tag)) fields[name] = getAttr(tag, "value") ?? "on";
      continue;
    }
    fields[name] = decodeHtmlEntities(getAttr(tag, "value") ?? "");
  }
  for (const m of scope.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const inner = m[2] ?? "";
    const sel = inner.match(/<option[^>]*\bselected\b[^>]*value="([^"]*)"/i)
            ?? inner.match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/i);
    fields[m[1]!] = sel ? (sel[1] ?? "") : "";
  }
  return fields;
}

export async function writeMemo(s: TouchgymSession, seq: string, freshHtml: string, memo: string) {
  const fields = extractFormFields(freshHtml);
  fields["memo"] = memo;
  fields["seq2"] = fields["seq2"] ?? seq;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const res = await fetch(`${s.appOrigin}/m/member/minfo.php?seq=${encodeURIComponent(seq)}&q=w`, {
    method: "POST", redirect: "manual",
    headers: {
      "user-agent": UA, cookie: `PHPSESSID=${s.sid}`,
      "content-type": "application/x-www-form-urlencoded",
      referer: `${s.appOrigin}/m/member/minfo.php?qa=1&seq=${encodeURIComponent(seq)}`,
    },
    body,
  });
  if (res.status >= 400) throw new Error(`memo write failed: HTTP ${res.status}`);
}
```

---

## 6. 동시성 — 단일 writer 원칙

memo 갱신은 **읽고→고쳐서→쓰는(read-modify-write)** 비원자적 연산이다. 두 writer가 거의 동시에
각자 GET → 자기 변경만 반영 → POST 하면 **나중 POST가 먼저 것을 덮어써 유실**된다.

대응:

- **쓰기를 단일 직렬 writer로 묶어라.** Hyunwoo Talk은 **Cloudflare Durable Object(`Poller`,
  mailbox `seq`당 1개)**가 memo와 DB를 모두 책임지는 유일한 writer다(`apps/api/src/poller.ts`).
  웹 사용자의 아웃바운드 전송도 이 DO를 통하므로 race가 없다.
- DO가 없다면: 단일 워커 프로세스 + 뮤텍스/큐, 또는 DB 행 잠금, 또는 "한 번에 한 요청만" 보장하는
  serverless 싱글톤을 둔다.
- 읽기는 여러 곳에서 해도 무방하다(폴링). **쓰기만** 직렬화하면 된다.

---

## 7. 폴링 전략 (실시간성 확보)

Touchgym은 push가 없으므로 **주기적 폴링**으로 변경을 감지한다. 무지성 `setInterval`은
스택업/소켓 누수를 부르므로 다음을 권장:

- **self-chaining 루프**: 직전 폴링이 *끝난 뒤*에만 다음 폴링을 예약 → 동시에 1요청만.
  (콘솔 구현 `startPolling()` 참고. `setInterval`은 정지된 네트워크에 계속 쏴서 소켓을 쌓는다.)
- **적응형 간격**(서버, `poller.ts`):
  - 평상시 **60초**, 메시지 활동 후 1시간 동안 **2초**(빠른 응답), **00:00–05:00 KST 정지**(불필요 트래픽 차단).
  - Durable Object **alarm**으로 다음 폴링을 스케줄, **1분 cron heartbeat**로 죽은 alarm을 되살림.
- **하드 타임아웃**(콘솔, 15초 `AbortController`): 멈춘 요청이 소켓을 영구 점유하지 않도록.

---

## 8. memo 안의 데이터 인코딩

memo는 그냥 문자열이므로 **자체 직렬화 포맷**을 정의한다. Hyunwoo Talk의 라인 프로토콜 예
(`packages/shared/src/protocol.ts`):

```
HWT1|<id>|<fromId>|<toId>|<ts>|<payloadBase64>
```

설계 원칙(범용적으로 유용):

1. **고정 접두어**(`HWT1`)로 내 라인을 식별 → 사람이 직접 쓴 메모와 안전하게 공존,
   파싱 시 접두어 없는 줄은 무시.
2. **구분자 충돌 회피**: 구분자(`|`)가 안 들어가는 필드만 그 자리에 두고, payload(임의 데이터)는
   **마지막 칸**에 두어 `split` 후 `slice(5).join("|")`로 복원(base64라 `|`/개행 없음).
3. **한 메시지 = 한 줄**, 전체 memo = 여러 줄. 파싱은 `\r?\n` 분리.
4. **보존 윈도우 관리**(아래 ⚠️ 때문):
   - **Touchgym은 memo의 "어제+오늘"(KST)만 보존**한다고 관찰됨 → 오래된 데이터는 사라질 수 있다.
   - 따라서 memo는 **휘발성 2일 버퍼**로 취급하고, **영구 보관은 별도 DB**(여기선 Cloudflare D1)에 한다.
   - 쓸 때마다 보존 윈도우 밖 라인은 잘라낸다(`appendToMemo`/`pruneMemo`). 이는 memo가 무한정
     커지는 것도 막아준다(필드 길이 한계 미상이므로 작게 유지하는 게 안전).

> ⚠️ **memo를 영구 저장소로 신뢰하지 말 것.** 짧은 수명의 교환 버퍼로만 쓰고, 진실의 원천(source of
> truth)은 내 DB에 둔다.

### 8.1 (선택) 페이로드 암호화

memo는 **gym 관리자라면 평문으로 다 보인다.** 민감 데이터는 반드시 암호화해서 넣는다.
Hyunwoo Talk은 Web Crypto만으로 **AES-GCM + PBKDF2-SHA256(210k)** 을 쓴다
(`packages/shared/src/crypto.ts`). 페이로드 와이어 포맷:

```
base64( salt(16B) || iv(12B) || AES-GCM-ciphertext+tag )
```

동일 코드가 브라우저/Worker/콘솔에서 그대로 도는 게 장점(Web Crypto는 셋 다 지원).

---

## 9. 브라우저 콘솔 모드 상세

Touchgym 회원 페이지(`https://wN.touchgym.co.kr/m/member/`)의 DevTools 콘솔에서 도는 스크립트
(`console/hyunwoo-talk.js`)의 요점:

- **세션 재사용**: 이미 로그인된 페이지이므로 `fetch(url, { credentials: "include" })` 로
  쿠키가 자동으로 실린다. 직접 로그인 안 함.
- **origin**: `const APP_ORIGIN = window.location.origin` — 지금 보고 있는 club app 호스트를 그대로 사용.
- **읽기**: `fetch(.../minfo.php?qa=1&seq=)` → `new DOMParser().parseFromString(html, "text/html")`
  → `doc.querySelector('textarea[name="memo"]').value`.
- **쓰기**: `form[name="form"]`의 컨트롤을 순회(`input,select,textarea`)하며 §5.3 규칙대로 모아
  `memo`만 교체 후 `application/x-www-form-urlencoded`로 POST.
- **타임아웃**: `AbortController` + 15초. 멈춘 요청이 소켓을 잡고 안 놓는 문제 방지.
- **⚠️ 하트비트 throttle(중요한 함정)**: 회원 페이지는 자체 SSL 점검 하트비트를 돌린다
  (`getLog2ssl` → `$.ajax`로 `c4.touchgym.co.kr/checking_ssl.php` → `scheduleLog` → 반복).
  이 호스트가 멈추면 루프가 강하게 재시도하며 **브라우저 소켓 풀을 소진(`net::ERR_NO_BUFFER_SPACE`)**,
  그러면 페이지의 모든 요청(우리 폴링 포함)이 깨진다.
  - 대응: `window.getLog2ssl`을 래핑해 **최소 30초에 한 번만** 실제 호출을 허용하고, 쿨다운 동안
    재예약을 직접 관리한다. 페이지 새로고침으로 원복.
  - 교훈: **Touchgym 페이지 위에서 장시간 도는 스크립트는, 페이지 자체의 폭주 타이머를 길들여야 한다.**

---

## 10. 운영상 함정 (Gotchas) 체크리스트

| # | 항목 | 내용 / 대응 |
|---|------|------------|
| 1 | **레거시 TLS** | `touchgym.co.kr`(apex)는 낮춘 OpenSSL 보안수준을 요구한 이력(`curl --ciphers DEFAULT@SECLEVEL=1`). SECLEVEL2 모던 클라이언트는 SSL 핸드셰이크 실패(curl exit 35) 가능. 사용하는 HTTP 클라이언트/런타임이 협상 가능한지 **직접 검증**하라. (Hyunwoo Talk은 Cloudflare Workers `fetch`로 프로덕션 동작 중.) |
| 2 | **동적 app origin** | club의 `dbinfo` 샤드에 따라 `wN`이 달라짐(grd2→w3, dbinfo=14). 하드코딩 금지, 로그인 리다이렉트에서 발견. |
| 3 | **올바른 `seq`** | mailbox로 쓸 회원 `seq`는 **그 club/샤드에 실제 존재**해야 함. 다른 club의 샘플 seq(`5966856` 등)는 minfo가 빈 페이지를 반환. |
| 4 | **폼 전체 보존** | 쓰기 시 memo만 보내면 회원 데이터 소실. 항상 fresh GET → 전체 필드 재전송. |
| 5 | **단일 writer** | memo는 RMW. 동시 쓰기 유실 → 직렬화 필수(§6). |
| 6 | **휘발성 보존** | "어제+오늘"만 남음. 영구 저장은 별도 DB. memo는 작게 유지. |
| 7 | **세션 만료** | 회원 GET이 3xx거나 HTML에 `memo` 없으면 만료 → 1회 재로그인 후 재시도(`withSession`). 세션은 캐시해 재사용. |
| 8 | **UA / Referer** | 브라우저 UA와 적절한 `referer`를 보내야 안정적. |
| 9 | **CORS 불가** | 제3 origin 브라우저에서 직접 호출 불가 → 서버 경유 또는 페이지 내 스크립트(§2). |
| 10 | **HTML 엔티티** | memo/필드 값은 엔티티 인코딩됨. 읽을 때 디코딩, 정규식 파싱이면 `&amp;`는 마지막에 치환. |
| 11 | **페이지 폭주 타이머** | 콘솔 모드 장시간 구동 시 `getLog2ssl` throttle 필요(§9). |

---

## 11. 보안 고려사항

- **자격증명의 무게**: 여기서 쓰는 로그인은 **gym 관리자 계정**이다. 이걸 가진 코드는 회원 DB 전체를
  읽고 쓸 수 있다. 비밀(`TOUCHGYM_ID`/`TOUCHGYM_PASSWORD`)은 **서버 시크릿**으로만 보관하고
  클라이언트에 노출 금지.
- **memo는 평문 노출**: 같은 club 관리자라면 누구나 본다. 민감 정보는 **반드시 암호화**(§8.1).
- **부작용 최소화**: 데이터 필드는 memo로 한정하고, 폼 보존 원칙을 지켜 다른 회원 정보를 건드리지 말 것.
- **합법적 사용 범위**: 본인이 권한을 가진 club/계정에 한해 사용. 타인 데이터/계정 접근 금지.

---

## 12. 새 프로젝트 적용 체크리스트

1. [ ] **전송 방식 결정**: 서버 경유(권장) vs Touchgym 페이지 내 콘솔 스크립트.
2. [ ] **자격증명 확보**: `clubId`, 관리자 `userid`, `passwd`. 서버 시크릿에 저장.
3. [ ] **mailbox `seq` 선정**: 해당 club/샤드에 존재하는 회원 seq 1개.
4. [ ] **로그인 구현**: 쿠키 자 + 수동 리다이렉트로 `{ appOrigin, sid }` 획득(§3.4).
5. [ ] **읽기 구현**: `minfo.php?qa=1&seq=` GET → memo 추출 + 엔티티 디코딩(§4).
6. [ ] **쓰기 구현**: fresh GET → 폼 전체 보존하며 memo만 교체 → `minfo.php?seq=&q=w` POST(§5).
7. [ ] **세션 캐시 + 만료 시 재로그인** 래퍼(§10-7).
8. [ ] **단일 writer 직렬화** 보장(§6).
9. [ ] **데이터 포맷 + 보존/암호화**: 접두어 라인/JSON, 2일 윈도우 프루닝, 필요시 AES-GCM(§8).
10. [ ] **영구 저장은 별도 DB**, memo는 버퍼로만.
11. [ ] **폴링 루프**: self-chaining + 적응형 간격 + 하드 타임아웃(§7).
12. [ ] **런타임 TLS 검증**(§10-1)과 동적 origin/seq 정합성 테스트.

---

## 부록 A. 엔드포인트 레퍼런스

| 목적 | Method | URL | 인증/바디 |
|------|--------|-----|----------|
| 로그인 진입 | GET | `https://touchgym.co.kr/m/login.php?club_id=<clubId>` | — (초기 PHPSESSID 발급) |
| 로그인 제출 | POST | `https://www.touchgym.co.kr/m/login.php?q=w&URL=` | body: `club_id`,`userid`,`passwd` |
| 인증 핸드셰이크 | GET(302 추적) | `https://<wN>.touchgym.co.kr/m/auth.php?authkey=…&dbinfo=…` | 이전 홉 쿠키 |
| 회원 읽기 | GET | `{appOrigin}/m/member/minfo.php?qa=1&seq=<seq>` | `cookie: PHPSESSID=<sid>` |
| 회원 쓰기 | POST | `{appOrigin}/m/member/minfo.php?seq=<seq>&q=w` | 폼 전체 + `memo`, `cookie: PHPSESSID=<sid>` |

공통 헤더: `user-agent: <browser UA>`, 쓰기 시 `content-type: application/x-www-form-urlencoded`,
적절한 `referer`.

## 부록 B. 참고 소스 (이 저장소)

| 파일 | 역할 |
|------|------|
| `apps/api/src/lib/touchgym.ts` | 로그인(쿠키 자/멀티홉), memo 읽기/추출, 폼 보존 쓰기 |
| `apps/api/src/poller.ts` | 단일 writer Durable Object, 적응형 폴링/alarm, 세션 캐시·재로그인 |
| `packages/shared/src/protocol.ts` | memo 라인 프로토콜, KST 보존 윈도우/프루닝 |
| `packages/shared/src/crypto.ts` | AES-GCM + PBKDF2 페이로드 암호화(Web Crypto) |
| `console/hyunwoo-talk.js` | 브라우저 콘솔 클라이언트(세션 재사용, DOMParser, 하트비트 throttle) |

---

*문서 기준 검증일: 2026-06-21 (club `grd2`). Touchgym 사이트 구조가 바뀌면 폼 필드/엔드포인트/리다이렉트가
달라질 수 있으니, 적용 전 위 동작을 라이브로 재확인할 것.*

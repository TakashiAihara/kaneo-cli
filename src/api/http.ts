import type { ZodError, ZodType } from "zod";
import { OPERATIONS, type Operation } from "./registry";

// The transport under the generated client. Every generated call goes through
// kaneoFetch, so the key is checked, attached and reported on the same way for
// every operation, and every response is checked against the schema the
// generator passes in. Behaviour is pinned by tests/http.test.ts.
// The schema is not tied to T: it only decides whether a mismatch is reported,
// and the generated client passes none for an operation answering two
// different 2xx bodies (deleteLabel's 200 and 202), while still typing the
// options it forwards as this function's own. orval 8.39's fetch client passes
// a schema only when the success type is a single schema (hasSchema in
// @orval/fetch), with no setting to change that. REMOVE WHEN it passes one for
// a union: then the schema can be tied to T again.
// anonymous marks a route the server serves without authentication, so the key
// is neither fetched nor sent: fetching it can run a profile's api_key_command,
// whose failure must not stop a call that never needed a key.
// text marks a route whose document declares a non-JSON body (the calendar
// feed's text/calendar): the reply is handed back as the text it arrived as,
// since there is no JSON value to parse and no schema to check it against.
// credentialInUrl marks a route whose URL path is itself the credential (the
// calendar feed's token): the call stays anonymous, but the URL is owed the
// keepsCredential protection the key gets — refused over plain HTTP to a
// non-loopback host on the first hop and on every redirect, where a header
// could have been stripped and the path cannot.
// blob marks a route whose document declares a binary body (the project
// background's image/*, an asset or an avatar image): the reply is handed
// back as a Blob of the bytes it arrived as, since there is no JSON value to
// parse and no schema to check it against.
export type KaneoInit<T = unknown> = RequestInit & {
  schema?: ZodType<T> | ZodType;
  anonymous?: boolean;
  text?: boolean;
  credentialInUrl?: boolean;
  // The route as a template for diagnostics, for a route whose path is itself
  // the credential: the real path is the secret, so failures name
  // /calendar-feed/{token}/calendar.ics rather than what was dialled. Each
  // {...} segment also marks a credential whose spelling — escaped and
  // decoded — is masked out of anything else an error picks up, like a
  // server's echo of it in a Location or a message.
  servedAs?: string;
  blob?: boolean;
};

type ClientConfig = {
  baseUrl: string;
  // A function is asked only when a request is about to be sent, so a key that
  // has to be fetched (a profile's api_key_command) is not fetched by a run that
  // sends none.
  apiKey?: string | (() => string);
  // What --timeout bounds: one request, every request. Each page of a board gets
  // the whole of it, so a board's size does not decide whether it can be read.
  timeoutMs?: number;
  // KANEO_DEBUG is the switch the documentation names; taking it here as well
  // means the transport reports what it saw without every caller having to
  // remember to pass the flag on.
  debug?: boolean;
};

type Settings = Required<Omit<ClientConfig, "apiKey">> & { apiKey: () => string };

// Bounds a single request, as the Go build's DefaultTimeout did.
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
// A message is read on a terminal, so a long raw body is cut; the error keeps
// the whole of it for whoever wants to look closer.
const BODY_LIMIT = 200;
// The wait a rate-limited request may spend in all: the window Kaneo gives new
// API keys (60 s in apps/api/src/auth.ts, v2.32.0). A key created with a
// longer window can ask for more, which is then reported rather than sat out.
// The count stops a server that keeps answering a wait of 0 from being asked
// forever.
const RATE_LIMIT_BUDGET_MS = 60_000;
const RATE_LIMIT_RETRIES = 3;

// Whether a rate-limited request is waited out. Fail-open commands run from
// hooks, which must stay quiet and quick, so they turn it off.
let waitOutRateLimits = true;
export const setRateLimitWaits = (on: boolean): void => {
  waitOutRateLimits = on;
};

let settings: Settings = { baseUrl: "", apiKey: () => "", timeoutMs: DEFAULT_TIMEOUT_MS, debug: false };

// Called once per process, before the first generated call. The transport is a
// module the generated client imports, so there is no other way to hand it the
// settings it needs.
export const configureClient = (config: ClientConfig): void => {
  settings = {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: typeof config.apiKey === "function" ? config.apiKey : () => (config.apiKey as string | undefined) ?? "",
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    debug: config.debug ?? Boolean(process.env.KANEO_DEBUG),
  };
};

// Turns whatever the user configured into an API root.
//
// The site root serves the web app and answers 200 with HTML for *any* path,
// so a base that misses /api looks like a success that returns markup.
// Appending it here means no call site can make that mistake.
export const normalizeBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
};

// Whether a request to this URL may carry the API key.
//
// fetch forwards Authorization across a redirect that only changes the scheme,
// so an https endpoint redirecting to http on the same host would put the key
// on the wire in the clear; such a hop is issued without it instead. Loopback
// counts as secure: a self-hosted instance has no network to expose the key to,
// and requiring TLS there would make local use impossible.
export const keepsCredential = (target: string): boolean => {
  const url = parseUrl(target);
  if (!url) return false;
  return url.protocol === "https:" || isLoopback(hostName(url));
};

const parseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
};

// The host a URL names, ready to be compared: a URL keeps an IPv6 address in
// brackets, where Go's url.Hostname does not, and it keeps the case the address
// was written in, so two spellings of one host would otherwise look like two.
const hostName = (url: URL): string => url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

const isLoopback = (hostname: string): boolean => {
  if (hostname === "localhost") return true;
  // The whole of 127.0.0.0/8, which is what net.IP.IsLoopback counts. An IPv6
  // address is written in its compressed form by the URL parser, so ::1 needs no
  // spelling of its own here.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname === "::1";
};

// Raised instead of sending a credential where TLS is not protecting it — the
// key, or a credential the URL itself carries. The check runs before the
// request, so nothing leaves the process, and the message names the target but
// never the credential.
export class InsecureCredentialError extends Error {
  constructor(public readonly target: string) {
    super(
      `${target}: refusing to send credentials over plain HTTP; use https, or a loopback address for a local instance`,
    );
  }
}

// A failed API call. The message names the request the way Go's URL.Path did,
// and the fields are there so a command can say more than the message does.
export class KaneoApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly statusCode: number,
    public readonly messages: string[] = [],
    public readonly body = "",
  ) {
    super(`${describeFailure(method, path, statusCode, messages, body)}${rateLimitHint(path, statusCode)}`);
  }

  // Reports whether the call failed because the key was rejected, which the
  // commands answer with a hint about where the key comes from rather than by
  // repeating the server's wording.
  unauthorized(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
}

// Kaneo checks the key itself on every route outside /api/auth, and a key that
// has hit its rate limit is answered there with the same 401 as a wrong one:
// by default 100 requests are allowed until 60 seconds pass with none, and the
// limit is set per key. Only better-auth's own routes say 429. The reply
// cannot tell the cases apart, so the message says both are possible. It is
// part of the message so a command that wraps the error keeps it.
const rateLimitHint = (path: string, status: number): string =>
  status === 401 && !/\/api\/auth\//.test(path)
    ? "; Kaneo also answers 401 to a key that hit its rate limit (by default 100 requests with no 60-second pause), so if the key worked a moment ago, wait a minute and retry"
    : "";

const describeFailure = (method: string, path: string, status: number, messages: string[], body: string): string => {
  if (messages.length > 0) return `${method} ${path}: ${status}: ${messages.join("; ")}`;
  // The body comes trimmed as Go's TrimSpace trims it; trimming it again here
  // would drop a byte order mark Go kept in its Error.Body.
  if (body === "") return `${method} ${path}: ${status}`;
  return `${method} ${path}: ${status}: ${goBody(body)}`;
};

// Go's Error.Error() keeps the first 200 bytes of the body and appends "...",
// where a JavaScript string would count UTF-16 units: a body of multibyte
// characters is longer in bytes than it is in units, so it is measured and cut
// as Go cut it. A cut through a character reports the partial bytes as U+FFFD,
// where Go's string kept them raw.
const goBody = (body: string): string => {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= BODY_LIMIT) return body;
  // ignoreBOM keeps a leading byte order mark the way Go's body[:200] kept the
  // bytes; the default would drop it here even though goTrimSpace kept it.
  return `${new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, BODY_LIMIT))}...`;
};

export const kaneoFetch = async <T>(url: string, init: KaneoInit<T>): Promise<T> => {
  if (settings.baseUrl === "") throw new Error("no API URL configured");

  const { schema, anonymous, text: wantText, credentialInUrl, servedAs, blob: wantBlob, ...request } = init;
  // The endpoint as the generated client wrote it, query included: the spelling
  // the operation is looked up by, since reading it back first would split an id
  // that needed escaping into two segments of its own.
  const path = url;

  let method = (request.method ?? "GET").toUpperCase();
  let body = request.body ?? null;
  let target = new URL(settings.baseUrl + url);
  // The route every failure this call reports names: /api in front of it, the
  // query left out and escapes read back, which is what Go's send reported off
  // the request's URL.Path. It is taken before any redirect, as Go's was, so a
  // failure names the call that was made rather than the hop that failed. A
  // route whose path is the credential names itself by template instead, and
  // safe masks the credential's spelling out of whatever else an error picks
  // up — a Location or a message the server wrote can echo it back.
  const served = servedAs ?? servedPath(target);
  const mask = credentialMask(servedAs, target.pathname);
  const safe = (s: string): string => (mask === undefined ? s : mask(s));
  let headers = new Headers(request.headers);
  // A request that names its own document type keeps it — the calendar feed's
  // text/calendar, the project background's image/* — and everything else
  // still asks for JSON.
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const key = anonymous ? "" : settings.apiKey();
  // credentialInUrl puts a URL-carried credential under the same check the
  // key gets: the flag's request is anonymous, so the key's own condition
  // alone would never reach it.
  if (key !== "" || credentialInUrl === true) {
    if (!keepsCredential(target.href)) {
      throw new InsecureCredentialError(safe(`${target.protocol}//${target.host}`));
    }
    if (key !== "") headers.set("Authorization", `Bearer ${key}`);
  }

  // The cap --timeout puts on the request is what cuts it short. The same cap
  // covers the redirect chain, so a server that keeps redirecting cannot hold
  // the process open either.
  //
  // A --timeout of zero or less is not the default and not no timeout: it is a
  // budget that has already run out, so every request fails at once, which is
  // what a context.WithTimeout of no duration did.
  // The method the call was made with, before a 301, 302 or 303 rewrote it into
  // a GET. Failures name it together with served, the pair Go's send reported.
  // The operation is looked up by it as well, so a write turned into a GET is
  // still read as that write's reply, and a whitespace-only one fails to decode
  // as it does without the redirect.
  const called = method;
  const start = { method, body, target, headers };

  // A 429 from the API key's rate limiter says when to come back, and the
  // request is sent again after that long. --timeout still bounds each attempt;
  // the waits have a budget of their own, one limiter window, since a single
  // wait is never longer than that. The limiter refuses before the route runs,
  // so a write is not repeated by sending it again.
  let waited = 0;
  let retries = 0;
  let response: Response;
  let bytes: ArrayBuffer;
  for (;;) {
    ({ method, body, target } = start);
    // A copy, since following a redirect may edit the headers in place.
    headers = new Headers(start.headers);
    const cap = settings.timeoutMs > 0 ? AbortSignal.timeout(settings.timeoutMs) : AbortSignal.abort();
    const signal = cap;

    let location = "";
    for (let hop = 0; ; hop++) {
      // Go's http.Client reports this as it reports a request that got no answer:
      // the call's method and the Location it refused to follow, as the header
      // wrote it rather than resolved. send prefixes the call as for any failure.
      if (hop >= MAX_REDIRECTS) {
        throw new Error(
          `${called} ${served}: ${goOp(called)} ${JSON.stringify(safe(location))}: stopped after ${MAX_REDIRECTS} redirects`,
        );
      }
      try {
        // Followed by hand: only the transport knows whether the next hop may
        // still carry the key, and fetch decides that on its own.
        response = await fetch(target, { method, headers, body, signal, redirect: "manual" });
      } catch (e) {
        throw new Error(`${called} ${served}: ${safe(urlError(called, target, e, credentialInUrl === true))}`, {
          cause: e,
        });
      }
      const red = redirectTarget(response, target);
      if (red === undefined) break;
      if ("bad" in red) {
        // The way Go's client reports a Location it cannot parse: the call, the
        // request that answered it, and url.Parse's own account of the refusal.
        // The reason quotes pieces of the Location back — a refused port, a
        // bad escape — so it goes through the mask like the fields beside it.
        throw new Error(
          `${called} ${served}: ${goOp(called)} ${JSON.stringify(safe(shownHref(target, credentialInUrl === true)))}: failed to parse Location header ${JSON.stringify(safe(red.bad.location))}: parse ${JSON.stringify(safe(red.bad.at))}: ${safe(red.bad.why)}`,
        );
      }
      if ("unreachable" in red) {
        // The way Go's client reports a request that failed below the parse:
        // the call, then the resolved URL and the transport's reason for it.
        // The reason names what could not be carried — a scheme, a host — so
        // it goes through the mask like the URL beside it.
        throw new Error(
          `${called} ${served}: ${goOp(called)} ${JSON.stringify(safe(red.unreachable.url))}: ${safe(red.unreachable.why)}`,
        );
      }
      // A credential carried in the URL cannot be stripped the way the key's
      // header can, so an insecure hop is refused rather than followed bare.
      // The refused target is a Location's host, which can be the token itself.
      if (credentialInUrl === true && !keepsCredential(red.to.href)) {
        throw new InsecureCredentialError(safe(`${red.to.protocol}//${red.to.host}`));
      }
      location = red.location;
      // The key stays only where it would still be protected and where it was
      // already meant to go; a hop to an insecure host, or to another one, goes
      // on without it and the server decides.
      headers = withoutCredential(headers, target, red.to);
      // 301, 302 and 303 turn a write into a GET the way every other client
      // does, or the write would be replayed against a route that does not take
      // it. 307 and 308 keep the method and body, which is why the body has to
      // be replayable: the generated client always sends a serialized string.
      if (downgradeToGet(response.status, method)) {
        method = "GET";
        body = null;
        headers.delete("content-type");
      }
      // The body is the credential the headers cannot show: an integration
      // call sends its token inside it, and withoutCredential can strip only
      // the Authorization header. A hop that would replay the body against
      // another origin — another host or port, or the same host under another
      // scheme — is refused rather than followed, because the request was
      // meant for the origin it was first sent to and the body cannot be
      // redacted the way the key can.
      if (body !== null && red.to.origin !== start.target.origin) {
        throw new KaneoApiError(called, served, response.status, [
          `refusing to follow the redirect to ${safe(shownHref(red.to, credentialInUrl === true))}: the request body may carry a credential`,
        ]);
      }
      target = red.to;
    }

    try {
      // Read as bytes, because both decisions made from the body are the Go
      // build's: it judged an empty reply by its length in bytes and reported the
      // length in bytes when a reply failed to decode, neither of which is what a
      // string of the same reply would measure.
      bytes = await response.arrayBuffer();
    } catch (e) {
      throw new Error(`${called} ${served}: read body: ${safe(bodyReason(e))}`, { cause: e });
    }
    const wait = response.status === 429 ? tryAgainIn(bytes) : undefined;
    if (
      !waitOutRateLimits ||
      wait === undefined ||
      waited + wait > RATE_LIMIT_BUDGET_MS ||
      retries >= RATE_LIMIT_RETRIES
    )
      break;
    waited += wait;
    retries++;
    console.error(`kaneo: ${called} ${served}: rate limited, sending it again in ${wait}ms`);
    await Bun.sleep(wait);
  }
  // ignoreBOM leaves a byte order mark in the string instead of dropping it. Go
  // read the first byte of the body as the start of a value, so a reply carrying
  // one is a reply it could not read, while a mark this dropped leaves a body
  // that decodes.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  // Trimmed, because that is what the Go build's Error.Body holds and what its
  // Client.Do asked whether the document held anything of.
  const trimmed = goTrimSpace(text);

  // A non-2xx status and a 2xx carrying success:false are both failures: the
  // server reports validation problems the second way, so the status alone is
  // not enough to judge the call.
  const reported = failure(called, served, response.status, text, trimmed, wantBlob === true, safe);
  if (reported) {
    const wait = response.status === 429 ? tryAgainIn(bytes) : undefined;
    if (wait !== undefined && waitOutRateLimits) {
      reported.message +=
        retries >= RATE_LIMIT_RETRIES
          ? `; still rate limited after ${retries} retries`
          : `; waiting the ${wait}ms the server asks for would pass the ${RATE_LIMIT_BUDGET_MS / 1000}s spent on rate limits`;
    }
    throw reported;
  }

  // Which of the Go build's two request paths this is, which its two parsers
  // were told apart by as well: a reply the generated client read is decoded and
  // named after the operation it was read into, and the one request this CLI
  // issues without the generated client (the server's own document, for
  // api-check) is trimmed first and reported the way Client.Do reported it.
  const operation = operationAt(called, path);

  // A binary reply is the body itself, empty included: there is no JSON value
  // to parse and no schema to check it against, and the type the document
  // declares is the Blob, so an empty body is an empty Blob rather than the
  // undefined an empty JSON reply stands for.
  if (wantBlob) {
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    return new Blob([bytes], { type }) as T;
  }

  // A write that reports 204 has nothing to decode, and the generated types
  // say so by having nothing to return. What counts as empty is the Go build's
  // answer: a body of no bytes at all, so a 2xx carrying only whitespace is not
  // a reply to return zero values for but one that failed to decode, which is
  // what stopped the command there.
  //
  // A text reply is the body itself, empty included: there is no JSON value
  // whose absence would stand for a zero, and "" is what a text document of no
  // bytes is.
  if (wantText) return text as T;
  if (operation === undefined ? trimmed === "" : bytes.byteLength === 0) return undefined as T;

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (e) {
    const why = goDecodeReason(reason(e));
    // A reply that could not be read names the request the way a failure the
    // server reported does, since the two are read in the same place and the
    // reply alone says nothing about which call produced it.
    const what =
      operation === undefined ? `decode response: ${why}` : decodeFailure(response, bytes.byteLength, operation, why);
    throw new Error(`${called} ${served}: ${safe(what)}`, { cause: e });
  }
  if (schema) {
    const checked = schema.safeParse(decoded);
    // A deployed server older than the document omits fields the document
    // declares (backgroundVersion on a project, seen on a live instance on
    // 2026-10-03). The Go build decoded those leniently, so the body comes
    // back as it was sent and the mismatch is only worth mentioning when
    // somebody asked to see it.
    if (!checked.success && settings.debug) {
      reportMismatch(called, safe(path), checked.error);
    }
  }
  if (typeof decoded === "object" && decoded !== null) remember(decoded, `${called} ${served}`);
  return decoded as T;
};

// The request each object of a decoded reply came from, so a mapping done long
// after the call (a time that does not parse) can still name it. Keyed by the
// objects themselves rather than a "last request" variable, which would name
// the wrong call when two replies are being read at once or a mapping runs
// after a later request.
const origins = new WeakMap<object, string>();

const remember = (node: object, request: string): void => {
  origins.set(node, request);
  for (const child of Object.values(node)) {
    if (typeof child === "object" && child !== null) remember(child, request);
  }
};

// The `METHOD /api/path` of the request that produced this object of a reply, or
// undefined for one that did not come from a reply.
export const originOf = (node: object): string | undefined => origins.get(node);

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// What went wrong reading a reply's body, in the words Go's io.ReadAll failure
// carried. The only abort this transport passes in is the cap --timeout sets,
// which Go reported as a deadline exceeded — bare, with no "(Client.Timeout ...)"
// parenthetical: Go appends those only when its per-request deadline was the
// one that fired, and the command context every request carries always expires
// first (it is made with the same --timeout before the request is sent), so
// didTimeout was never true. Anything else is passed on as it came.
const bodyReason = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 20 || code === 23 ? "context deadline exceeded" : reason(e);
};

// What Go's strings.TrimSpace removes: Unicode's White_Space. That is what
// JavaScript's trim() removes except for two characters: it also counts the byte
// order mark, which would turn a reply holding nothing else into the empty one
// where Go read it as a body that failed to decode, and it leaves NEL (U+0085).
const goTrimSpace = (text: string): string => text.replace(/^(?:[^\S\uFEFF]|\u0085)+|(?:[^\S\uFEFF]|\u0085)+$/g, "");

// The operation a request was made for, as the registry of them sees it.
//
// The generated client is built for exactly the operations in the registry, and
// the one request this CLI makes without it is the server's own document, which
// the registry does not list. So a request that matches an entry came in through
// the generated client, and one that matches none is the hand-issued call the Go
// build's Client.Do issued — the two the Go build read an empty reply differently.
const operationAt = (method: string, path: string): Operation | undefined => {
  const route = (path.split("?")[0] ?? "").split("/");
  return OPERATIONS.find((o) => o.method === method && routeMatches(o.path.split("/"), route));
};

// A path template names a parameter in braces, and a parameter is any one
// segment: every id is escaped before it is written into a path, so a segment
// never carries a separator of its own to split on.
const routeMatches = (template: string[], route: string[]): boolean =>
  template.length === route.length && template.every((part, i) => part.startsWith("{") || part === route[i]);

// How the runtime the Go build's generated client decodes through reported a
// reply it could not read: the status and content type as they arrived, the
// length of the body in bytes, the type it was reading that body into, and the
// parse error underneath. The body itself is left out of it on purpose, so a
// reply carrying something private does not end up wherever the message is
// quoted.
//
// The status is the one the reply carried, where the Go build's names 200 for
// all of them: its transport rewrote every status before the generated parser
// saw a reply, because those parsers accepted only the 200 the document
// declares. That rewrite is not reproduced, as nothing here needs it.
const decodeFailure = (response: Response, length: number, operation: Operation, why: string): string =>
  `error decoding response: status=${response.status}, content-type=${response.headers.get("content-type") ?? ""}, ` +
  `content-length=${length}, target-type=${responseTypeOf(operation)}: ${why}`;

// The name Go's generated client gave the type it read a reply into: the
// operation's id as Go spells a name and "Response" after it.
const responseTypeOf = (operation: Operation): string =>
  `${operation.id[0]!.toUpperCase()}${operation.id.slice(1)}Response`;

// What Go's encoding/json says, given what JSON.parse says. A document that runs
// out before it holds a value is the one both parsers call the end of the input,
// and it is what a server answering with nothing but whitespace produces, so
// that case is translated. The rest is passed on as it comes: Go names the
// character it tripped over and the value it wanted there ("invalid character
// '<' looking for beginning of value"), which is a report of its own scanner to
// reproduce, and saying a differently worded reason is better than saying a
// wrong one.
const goDecodeReason = (why: string): string => (why.includes("Unexpected EOF") ? "unexpected end of JSON input" : why);

// The path a request was made on, as the server saw it: /api included,
// percent-escapes read back and the query left out. That is the Go build's
// URL.Path, so an escaped id reads as the id that was asked for; it is not a
// spelling to paste into curl, where the escapes would have to be put back. A
// call that never got an answer names the URL it dialled in the reason after it.
const servedPath = (target: URL): string => {
  try {
    return decodeURIComponent(target.pathname);
  } catch {
    // A path that is not valid encoding is the caller's, not something to try to
    // decode into a different route.
    return target.pathname;
  }
};

// Go's net/http reports a request that never got an answer as
// `Get "URL": reason`: the method in title case, the whole URL it dialled, and
// the failure underneath.
//
// Bun's own wording names none of that ("Unable to connect. Is the computer able
// to access the url?"), which leaves nothing to act on and nothing to search
// for, so both the shape and the reasons are rebuilt here from the error code.
const urlError = (method: string, target: URL, e: unknown, credentialInUrl: boolean): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return `${goOp(method)} ${JSON.stringify(shownHref(target, credentialInUrl))}: ${dialReason(target, code, e)}`;
};

// A method as url.Error names it. Go's client takes it from the first request of
// a redirect chain, so a write turned into a GET by a 303 is still a Post there.
const goOp = (method: string): string => (method === "" ? "Get" : method.slice(0, 1) + method.slice(1).toLowerCase());

// What went wrong below the request, in the words a Go user would recognise.
// Anything unrecognised is passed on as it is, since inventing a reason would be
// worse than a vague one.
const dialReason = (target: URL, code: unknown, e: unknown): string => {
  switch (code) {
    case "ConnectionRefused":
      // Go names the address it dialled. The host as written is that address
      // for a loopback port, which is where a refused connection is met.
      return `dial tcp ${target.host}: connect: connection refused`;
    case "ENOTFOUND":
      return `dial tcp: lookup ${target.hostname}: no such host`;
    // Both aborts are a timeout: the only signal this CLI passes in is the cap
    // --timeout sets, and Go reports that as a deadline exceeded — bare, for
    // the same reason bodyReason gives: the request's own context always
    // expires before Client.Timeout's deadline, so Go never appended its
    // "(Client.Timeout exceeded while awaiting headers)" here either.
    case 23:
    case 20:
      return "context deadline exceeded";
    default:
      return reason(e);
  }
};

// The endpoint rather than the route it was served on: the schema is the one the
// generated client asked to be checked against, so the endpoint is what says
// which schema was missed.
const reportMismatch = <T>(method: string, path: string, error: ZodError<T>): void => {
  const fields = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  console.error(`kaneo: ${method} ${path}: response does not match the schema, returned as sent: ${fields}`);
};

// What a 3xx's Location came to: a URL to follow, the way Go's url.Parse
// refused it, or — for a reference Go accepted but this runtime's URL cannot
// hold — the transport failure Go's send would have reported.
type Redirect =
  | { to: URL; location: string }
  | { bad: { location: string; at: string; why: string } }
  | { unreachable: { url: string; why: string } };

// Go's client reads the first of several Location headers; fetch's Headers
// joins them into one value separated by ", ", so the first of those is what is
// followed. There is no per-field accessor to do better with — getAll answers
// only for set-cookie and entries() yields the same joined value — and a
// single Location holding ", " itself is read as two here where Go read it
// whole, which no URL a server writes has reason to contain.
const firstLocation = (header: string | null): string | null => {
  if (header === null) return null;
  const comma = header.indexOf(", ");
  return comma === -1 ? header : header.slice(0, comma);
};

// The URL a failed request names the way Go's url.Error printed it: a set
// password is *** and the rest is the URL as it was written. On a route whose
// path is itself the credential there is no path to show — the scheme and
// host are what the message keeps, since the path is the secret.
const shownHref = (target: URL, credentialInUrl: boolean): string => {
  const u = new URL(target.href);
  const user = u.username === "" && u.password === "" ? "" : `${u.username}${u.password === "" ? "" : ":***"}@`;
  if (u.password !== "") u.password = "***";
  if (!credentialInUrl) return u.href;
  return `${u.protocol}//${user}${u.host}`;
};

// The spellings a credential-in-path route's path credential takes: each
// {...} segment of the servedAs template, in the URL's escaped form and
// decoded, so an echo of it — a Location that points back into the route, a
// message the server wrote — is masked the way a password is. undefined when
// the route names no template, in which case nothing is masked.
const credentialMask = (template: string | undefined, encodedPath: string): ((s: string) => string) | undefined => {
  if (template === undefined) return undefined;
  const marks = template.split("/");
  const segs = encodedPath.split("/");
  const secrets = new Set<string>();
  for (let i = 0; i < marks.length && i < segs.length; i++) {
    if (!/^\{[^}/]+\}$/.test(marks[i]!)) continue;
    const encoded = segs[i]!;
    if (encoded === "") continue;
    secrets.add(encoded);
    try {
      secrets.add(decodeURIComponent(encoded));
    } catch {
      // An escape that does not decode is masked only in the form written.
    }
  }
  if (secrets.size === 0) return undefined;
  // A credential stands alone in what it is echoed into — a path segment, a
  // quoted value — so the mask takes it only where it is not part of a longer
  // token-like run. Without that bound a short credential would be masked out
  // of ordinary words and the diagnostic would say nothing.
  const patterns = [...secrets].map(
    (secret) => new RegExp(`(?<![A-Za-z0-9_-])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "g"),
  );
  return (s: string) => {
    let out = s;
    for (const pattern of patterns) out = out.replace(pattern, "***");
    return out;
  };
};

const redirectTarget = (response: Response, from: URL): Redirect | undefined => {
  if (!REDIRECT_STATUSES.includes(response.status)) return undefined;
  const location = firstLocation(response.headers.get("location"));
  // Go reads an absent or empty Location as none and hands the 3xx back.
  if (!location) return undefined;
  // Go's client parses the Location with url.Parse before resolving it, and a
  // Location it refuses fails the call rather than being reported as the 3xx.
  // WHATWG's URL accepts some of what Go refuses (a % escape that is not two
  // hex digits, a space in the host is one both refuse but for different
  // reasons), so the parse is judged by Go's rules first.
  const bad = goLocationError(location);
  if (bad !== undefined) return { bad: { location, ...bad } };
  // Go's parse decides what the reference names before WHATWG's URL reads it:
  // a reference with no authority of its own (a ///path, a bare relative one)
  // or a scheme this client cannot carry is a path or a refusal there, where
  // URL would take the segment after the slashes for a host — or hand fetch a
  // file: it can read. Those go through the Go resolution below.
  const ref = goParseRef(location);
  if (
    ref !== undefined &&
    (ref.host === "" || (ref.scheme !== "" && ref.scheme !== "http" && ref.scheme !== "https"))
  ) {
    const miss = goLocationMiss(location, from);
    if (miss !== undefined) return miss;
  }
  // Resolved against the URL that answered it, the way any other client would.
  try {
    const to = new URL(location, from);
    // Go's client sends the resolved path's escapes literally; this runtime's
    // URL parser re-normalizes an escaped dot segment (%2e and the spellings
    // that decode to one) where Go kept it, so a path Go resolved can arrive
    // here already changed. When they differ the hop cannot be made the way
    // Go would have made it — refuse rather than fetch another path.
    if (ref !== undefined) {
      const resolved = goResolvedRef(ref, from);
      if (!goPathHeld(to, goText(resolved.path))) {
        return { unreachable: { url: goRefText(resolved), why: GO_PATH_DIVERGENT } };
      }
    }
    return { to, location };
  } catch {
    // Go's parse accepted this but WHATWG's URL cannot hold it; Go resolves
    // and sends it anyway, so the outcome is the transport's, not a refusal.
    const miss = goLocationMiss(location, from);
    if (miss !== undefined) return miss;
    return { bad: { location, at: location, why: "Invalid URL" } };
  }
};

// Go's url.Parse of a Location, returning the error text it would report, or
// undefined when it accepts the reference. Only the checks that can fail are
// reproduced; a reference Go accepts is resolved by URL, which reads the same
// grammar closely enough for the targets a redirect names.
const goLocationError = (location: string): { at: string; why: string } | undefined => {
  // Parse cuts the fragment off first and parses what is left; a fragment is
  // checked after, and its failure is reported against the whole reference.
  const hash = location.indexOf("#");
  const main = hash === -1 ? location : location.slice(0, hash);
  const frag = hash === -1 ? "" : location.slice(hash + 1);
  const why = goParseError(main);
  if (why !== undefined) return { at: main, why };
  if (frag !== "") {
    const fwhy = goUnescapeError(frag, "fragment");
    if (fwhy !== undefined) return { at: location, why: fwhy };
  }
  return undefined;
};

// The errors net/url's parse reports for the part before the fragment: the
// control-byte check, the scheme, the first-segment-colon rule for a relative
// reference, the authority and the path's escapes. Query escapes are not
// checked, as RawQuery keeps them as written.
const goParseError = (u: string): string | undefined => {
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "net/url: invalid control character in URL";
  }
  const scheme = goScheme(u);
  if ("error" in scheme) return scheme.error;
  let rest = scheme.rest;
  const query = rest.indexOf("?");
  rest = query === -1 ? rest : rest.slice(0, query);
  if (!rest.startsWith("/")) {
    if (scheme.scheme !== "") return undefined;
    const slash = rest.indexOf("/");
    const first = slash === -1 ? rest : rest.slice(0, slash);
    if (first.includes(":")) return "first path segment in URL cannot contain colon";
  }
  if (rest.startsWith("//") && (scheme.scheme !== "" || !rest.startsWith("///"))) {
    const after = rest.slice(2);
    const slash = after.indexOf("/");
    const authority = slash === -1 ? after : after.slice(0, slash);
    rest = slash === -1 ? "" : after.slice(slash);
    const aerr = goAuthorityError(authority);
    if (aerr !== undefined) return aerr;
  }
  return goUnescapeError(rest, "path");
};

// getScheme: a leading scheme is letters then letters, digits, +, - or . up to
// a colon; anything else means there is no scheme and the whole string is the
// reference.
const goScheme = (s: string): { scheme: string; rest: string } | { error: string } => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i]!;
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) continue;
    if ((c >= 48 && c <= 57) || ch === "+" || ch === "-" || ch === ".") {
      if (i === 0) return { scheme: "", rest: s };
      continue;
    }
    if (ch === ":") {
      if (i === 0) return { error: "missing protocol scheme" };
      return { scheme: s.slice(0, i), rest: s.slice(i + 1) };
    }
    return { scheme: "", rest: s };
  }
  return { scheme: "", rest: s };
};

// parseAuthority: the host is read before the userinfo, so a bad host is
// reported first; the userinfo then has to be made of the characters
// validUserinfo allows before its escapes are checked.
const goAuthorityError = (authority: string): string | undefined => {
  const at = authority.lastIndexOf("@");
  const host = at === -1 ? authority : authority.slice(at + 1);
  const herr = goHostError(host);
  if (herr !== undefined) return herr;
  if (at === -1) return undefined;
  const userinfo = authority.slice(0, at);
  if (![...userinfo].every((c) => GO_USERINFO.test(c))) return "net/url: invalid userinfo";
  return goUnescapeError(userinfo, "user");
};

const GO_USERINFO = /[A-Za-z0-9\-._:~!$&'()*+,;=%@]/;

// parseHost: an bracketed host needs its closing bracket and a port of digits
// or nothing; any other host takes the port after its last colon the same
// way. The host itself is then unescaped with the host rules — except that a
// %25 inside the brackets introduces an RFC 6874 zone identifier, which
// unescapes under the zone's own, looser rules while the address and port
// around it keep the host's.
const goHostError = (host: string): string | undefined => {
  if (host.startsWith("[")) {
    const i = host.lastIndexOf("]");
    if (i < 0) return "missing ']' in host";
    const colonPort = host.slice(i + 1);
    if (!goValidPort(colonPort)) return `invalid port ${JSON.stringify(colonPort)} after host`;
    const zone = host.slice(0, i).indexOf("%25");
    if (zone === -1) return goUnescapeError(host, "host");
    const head = goUnescapeError(host.slice(0, zone), "host");
    if (head !== undefined) return head;
    const zoned = goUnescapeError(host.slice(zone, i), "zone");
    if (zoned !== undefined) return zoned;
    return goUnescapeError(host.slice(i), "host");
  }
  const i = host.lastIndexOf(":");
  if (i !== -1) {
    const colonPort = host.slice(i);
    if (!goValidPort(colonPort)) return `invalid port ${JSON.stringify(colonPort)} after host`;
  }
  return goUnescapeError(host, "host");
};

// validOptionalPort: empty, or a colon and digits only — the count is not
// checked, so :99999 parses.
const goValidPort = (port: string): boolean => port === "" || /^:\d*$/.test(port);

const goIsHex = (c: string): boolean => (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const goUnhex = (c: string): number => {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  return code - 55;
};

// The first n bytes of s as Go's byte-slice would take them, decoded back. A
// cut through a multi-byte character reports U+FFFD where Go's string kept
// the partial bytes raw.
const goByteSlice = (s: string, n: number): string =>
  new TextDecoder().decode(new TextEncoder().encode(s).subarray(0, n));

// The characters a host may hold unescaped: what shouldEscape leaves alone for
// encodeHost, which is the unreserved set plus the sub-delims and : [ ] < > ".
const GO_HOST_LITERAL = /[A-Za-z0-9\-_.~!$&'()*+,;=:[\]<>"']/;

// unescape's failure cases for one section of the URL. A % not followed by two
// hex digits is an EscapeError showing the % and up to two bytes after it; the
// host additionally refuses escapes of ASCII bytes below 8 other than %25, and
// any ASCII character that should be escaped. The zone an IPv6 literal's %25
// introduces is looser still: it also takes %25 itself, a space, and any
// escape whose byte the host rules would leave alone.
const goUnescapeError = (s: string, mode: "path" | "fragment" | "user" | "host" | "zone"): string | undefined => {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "%") {
      if (i + 2 >= s.length || !goIsHex(s[i + 1]!) || !goIsHex(s[i + 2]!)) {
        // Go slices the bad escape as bytes, not characters: "%é" is three of
        // them where "%éx" would be three UTF-16 units.
        return `invalid URL escape ${JSON.stringify(goByteSlice(s.slice(i), 3))}`;
      }
      const hex = s.slice(i, i + 3);
      if (mode === "host" && goUnhex(s[i + 1]!) < 8 && hex !== "%25") {
        return `invalid URL escape ${JSON.stringify(hex)}`;
      }
      if (mode === "zone") {
        const v = (goUnhex(s[i + 1]!) << 4) | goUnhex(s[i + 2]!);
        if (hex !== "%25" && v !== 0x20 && goShouldEscape(v, "host")) {
          return `invalid URL escape ${JSON.stringify(hex)}`;
        }
      }
      i += 2;
      continue;
    }
    if ((mode === "host" || mode === "zone") && s.charCodeAt(i) < 0x80 && !GO_HOST_LITERAL.test(ch)) {
      return `invalid character ${JSON.stringify(ch)} in host name`;
    }
  }
  return undefined;
};

// A Location that goLocationError passed but WHATWG's URL cannot hold — a port
// above 65535, an empty host on a special scheme, an invalid IP literal. Go's
// url.Parse accepted it, so the client resolved it and the send failed in the
// transport; the error reported is the transport's, not a parse refusal.
//
// net/url keeps a URL as bytes and the Location arrives as UTF-16, so the
// pieces below are read as the UTF-8 bytes Go's parser saw: one char code per
// byte, with every check and re-escape done per byte as Go did it.
const goBytes = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
};

const goText = (b: string): string => {
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
};

// unescape with the checks already made: each %XX becomes its byte.
const goUnescapeBytes = (b: string): string => {
  if (!b.includes("%")) return b;
  let out = "";
  for (let i = 0; i < b.length; i++) {
    if (b[i] === "%" && i + 2 < b.length) {
      out += String.fromCharCode((goUnhex(b[i + 1]!) << 4) | goUnhex(b[i + 2]!));
      i += 2;
    } else {
      out += b[i];
    }
  }
  return out;
};

type GoMode = "path" | "host" | "user" | "fragment";

// shouldEscape for the modes a URL's parts are escaped with, per byte.
const goShouldEscape = (c: number, mode: GoMode): boolean => {
  if (c > 0x7f) return true;
  const ch = String.fromCharCode(c);
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return false;
  if (mode === "host" && "!$&'()*+,;=:[]<>\"".includes(ch)) return false;
  if ("-_.~".includes(ch)) return false;
  if ("$&+,/:;=?@".includes(ch)) {
    if (mode === "path") return ch === "?";
    if (mode === "user") return ch === "@" || ch === "/" || ch === "?" || ch === ":";
    if (mode === "fragment") return false;
    return true;
  }
  if (mode === "fragment" && "!()*".includes(ch)) return false;
  return true;
};

const GO_UPPERHEX = "0123456789ABCDEF";
const goEscape = (b: string, mode: GoMode): string => {
  let out = "";
  for (let i = 0; i < b.length; i++) {
    const c = b.charCodeAt(i);
    out += c < 0x80 && !goShouldEscape(c, mode) ? b[i] : `%${GO_UPPERHEX[c >> 4]!}${GO_UPPERHEX[c & 15]!}`;
  }
  return out;
};

// validEncoded: whether a raw escaping needs no further escaping, which is
// when URL.String keeps it as RawPath/RawFragment did.
const goValidEncoded = (b: string, mode: GoMode): boolean => {
  for (let i = 0; i < b.length; i++) {
    const ch = String.fromCharCode(b.charCodeAt(i));
    if ("!$&'()*+,;=:@".includes(ch) || ch === "[" || ch === "]" || ch === "%") continue;
    if (goShouldEscape(b.charCodeAt(i), mode)) return false;
  }
  return true;
};

// EscapedPath/EscapedFragment: the raw escaping is kept when it is already
// canonical, otherwise the decoded value is escaped afresh.
const goEscaped = (raw: string, decoded: string, mode: GoMode): string =>
  goValidEncoded(raw, mode) ? raw : goEscape(decoded, mode);

// The pieces of a Location in the form net/url's parse produced them.
type GoRef = {
  scheme: string;
  opaque: string;
  omitHost: boolean;
  user: { name: string; passSet: boolean } | undefined;
  host: string;
  path: string;
  query: string;
  forceQuery: boolean;
  fragment: string;
};

// parse for a reference already known to be Go-valid: the scheme, the query
// cut, the authority, and the path and fragment in their escaped forms.
const goParseRef = (location: string): GoRef | undefined => {
  const loc = goBytes(location);
  const hash = loc.indexOf("#");
  const main = hash === -1 ? loc : loc.slice(0, hash);
  const fragRaw = hash === -1 ? "" : loc.slice(hash + 1);
  const scheme = goScheme(main);
  if ("error" in scheme) return undefined;
  const name = scheme.scheme.toLowerCase();
  let rest = scheme.rest;
  let query = "";
  let forceQuery = false;
  if (rest.endsWith("?") && rest.split("?").length === 2) {
    forceQuery = true;
    rest = rest.slice(0, -1);
  } else {
    const q = rest.indexOf("?");
    if (q !== -1) {
      query = rest.slice(q + 1);
      rest = rest.slice(0, q);
    }
  }
  let opaque = "";
  let omitHost = false;
  let path = "";
  let userinfoRaw: string | undefined;
  let host = "";
  if (!rest.startsWith("/")) {
    if (name !== "") {
      opaque = rest;
    } else {
      path = rest;
    }
  } else if (rest.startsWith("//") && (name !== "" || !rest.startsWith("///"))) {
    const body = rest.slice(2);
    const slash = body.indexOf("/");
    const authority = slash === -1 ? body : body.slice(0, slash);
    path = slash === -1 ? "" : body.slice(slash);
    const at = authority.lastIndexOf("@");
    const hostPart = at === -1 ? authority : authority.slice(at + 1);
    if (at !== -1) userinfoRaw = authority.slice(0, at);
    host = goUnescapeBytes(hostPart);
  } else if (name !== "" && rest.startsWith("/")) {
    omitHost = true;
    path = rest;
  } else {
    path = rest;
  }
  const pathDecoded = goUnescapeBytes(path);
  const fragDecoded = goUnescapeBytes(fragRaw);
  let user: GoRef["user"];
  if (userinfoRaw !== undefined) {
    const colon = userinfoRaw.indexOf(":");
    user =
      colon === -1
        ? { name: goUnescapeBytes(userinfoRaw), passSet: false }
        : { name: goUnescapeBytes(userinfoRaw.slice(0, colon)), passSet: true };
  }
  return {
    scheme: name,
    opaque,
    omitHost,
    user,
    host,
    path: goEscaped(path, pathDecoded, "path"),
    query,
    forceQuery,
    fragment: goEscaped(fragRaw, fragDecoded, "fragment"),
  };
};

// resolvePath: the reference's escaped path resolved against the base's —
// a reference path that does not start with / is joined to the base's last
// segment, and an empty one takes the base's whole. What an absolute or
// authority reference gets is the base-less call.
const goResolvePath = (base: string, ref: string): string => {
  let full = ref;
  if (ref === "") {
    full = base;
  } else if (!ref.startsWith("/")) {
    full = `${base.slice(0, base.lastIndexOf("/") + 1)}${ref}`;
  }
  if (full === "") return "";
  let dst = "/";
  let first = true;
  let remaining = full;
  let elem = "";
  let found = true;
  while (found) {
    const cut = remaining.indexOf("/");
    if (cut === -1) {
      elem = remaining;
      remaining = "";
      found = false;
    } else {
      elem = remaining.slice(0, cut);
      remaining = remaining.slice(cut + 1);
      found = true;
    }
    if (elem === ".") {
      first = false;
      continue;
    }
    if (elem === "..") {
      const str = dst.slice(1);
      const index = str.lastIndexOf("/");
      dst = "/";
      if (index === -1) {
        first = true;
      } else {
        dst += str.slice(0, index);
      }
    } else {
      if (!first) dst += "/";
      dst += elem;
      first = false;
    }
  }
  if (elem === "." || elem === "..") dst += "/";
  return dst.length > 1 && dst[1] === "/" ? dst.slice(1) : dst;
};

// URL.String with stripPassword's rule: a set password prints as *** and the
// rest is the escaped form. Returned as the same byte string it was built
// from; the caller decodes it once.
const goRefText = (u: GoRef): string => {
  let out = u.scheme === "" ? "" : `${u.scheme}:`;
  if (u.opaque !== "") {
    out += u.opaque;
  } else {
    const hasUser = u.user !== undefined;
    if (u.scheme !== "" || u.host !== "" || hasUser) {
      if (!(u.omitHost && u.host === "" && !hasUser)) {
        if (u.host !== "" || u.path !== "" || hasUser) out += "//";
        if (u.user !== undefined) {
          out += u.user.passSet ? `${u.user.name}:***@` : `${goEscape(u.user.name, "user")}@`;
        }
        if (u.host !== "") out += goEscape(u.host, "host");
      }
    }
    if (u.path !== "" && !u.path.startsWith("/") && u.host !== "") out += "/";
    if (out === "" && u.path !== "" && u.path.split("/")[0]!.includes(":")) out += "./";
    out += u.path;
  }
  if (u.forceQuery || u.query !== "") out += `?${u.query}`;
  if (u.fragment !== "") out += `#${u.fragment}`;
  return goText(out);
};

// splitHostPort: the port after the last colon when it is all digits, and the
// brackets off an IP literal.
const goSplitHost = (host: string): { hostname: string; port: string } => {
  let h = host;
  let port = "";
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && goValidPort(host.slice(colon))) {
    h = host.slice(0, colon);
    port = host.slice(colon + 1);
  }
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return { hostname: h, port };
};

// What the transport reports for a resolved reference it cannot use, in the
// order it checks: the scheme, the host, then the port inside the dial. A host
// that only fails at the lookup is reported the way dialReason reports one.
const goMissReason = (u: GoRef): string => {
  if (u.scheme !== "http" && u.scheme !== "https") {
    return `unsupported protocol scheme ${JSON.stringify(goText(u.scheme))}`;
  }
  if (u.host === "") return "http: no Host in request URL";
  const { hostname, port } = goSplitHost(u.host);
  if (port !== "" && Number(port) > 65535) return `dial tcp: address ${port}: invalid port`;
  return `dial tcp: lookup ${goText(hostname)}: no such host`;
};

// Why a resolved reference is refused when this runtime's URL parser cannot
// hold the path Go resolved: the parser reads %2e — in any of the spellings
// that decode to a dot — as the dot segment it encodes and re-normalizes the
// path around it, where Go's resolvePath kept the escape and its client sent
// it literally. Following the URL object would fetch a different path than
// Go's would have, so the hop is a transport refusal naming what Go resolved.
const GO_PATH_DIVERGENT = "the resolved path's %2e escapes are re-normalized by this runtime's URL parser";

// The userinfo a resolved reference inherits from the URL that answered it,
// in the form GoRef keeps: the name decoded, passSet when a password was
// written. goRefText prints a set password as *** either way.
const goFromUser = (from: URL): GoRef["user"] => {
  if (from.username === "" && from.password === "") return undefined;
  let name = from.username;
  try {
    name = decodeURIComponent(name);
  } catch {
    // A username that is not valid percent-encoding is kept as written.
  }
  return { name: goBytes(name), passSet: from.password !== "" };
};

// The GoRef ResolveReference would produce for a reference Go's parse
// accepted: a reference that names an authority or scheme resolves its own
// escaped path alone, a relative one resolves against the answering URL's.
// The path stays escaped, as Go's URL keeps it.
const goResolvedRef = (ref: GoRef, from: URL): GoRef => {
  if (ref.scheme !== "" || ref.host !== "" || ref.user !== undefined) {
    return {
      ...ref,
      scheme: ref.scheme === "" ? from.protocol.slice(0, -1) : ref.scheme,
      path: goResolvePath(ref.path, ""),
    };
  }
  return {
    scheme: from.protocol.slice(0, -1),
    opaque: "",
    omitHost: false,
    user: goFromUser(from),
    host: from.host,
    path: goResolvePath(goBytes(from.pathname), ref.path),
    query: ref.query,
    forceQuery: ref.forceQuery,
    fragment: ref.fragment,
  };
};

// Whether the URL object holds the path Go resolved. resolvedPath is the
// escaped spelling Go sends; u.pathname is the same spelling sent on the
// wire. They differ only when the parser re-normalized something — every
// other byte of an escaped path round-trips through the setter unchanged.
const goPathHeld = (u: URL, resolvedPath: string): boolean => u.pathname === (resolvedPath === "" ? "/" : resolvedPath);

// The way Go's client treats a Location url.Parse accepted but WHATWG's URL
// cannot hold: it resolves the reference against the URL that answered, and
// either the resolution is a URL this runtime can still fetch (an empty
// authority inherits the base) or the send fails in the transport.
const goLocationMiss = (location: string, from: URL): Redirect | undefined => {
  const ref = goParseRef(location);
  if (ref === undefined) return undefined;
  if (ref.scheme !== "" || ref.host !== "" || ref.user !== undefined) {
    const resolved: GoRef = {
      ...ref,
      scheme: ref.scheme === "" ? from.protocol.slice(0, -1) : ref.scheme,
      path: goResolvePath(ref.path, ""),
    };
    return { unreachable: { url: goRefText(resolved), why: goMissReason(resolved) } };
  }
  // An empty network-path reference inherits the base: // is the base itself,
  // and //?query, //#fragment or ///path differ from it only there. Resolve-
  // Reference still resolves the path against the base's and inherits the
  // base's query and fragment only when the reference carries none of its own.
  const u = new URL(from.href);
  const inheritsAll = ref.path === "" && !ref.forceQuery && ref.query === "";
  if (!inheritsAll) {
    const resolvedPath = goText(goResolvePath(goBytes(from.pathname), ref.path));
    u.pathname = resolvedPath;
    if (!goPathHeld(u, resolvedPath)) {
      return { unreachable: { url: goRefText(goResolvedRef(ref, from)), why: GO_PATH_DIVERGENT } };
    }
    u.search = ref.forceQuery ? "?" : ref.query === "" ? "" : `?${goText(ref.query)}`;
    u.hash = ref.fragment === "" ? "" : `#${goText(ref.fragment)}`;
  } else if (ref.fragment !== "") {
    u.hash = `#${goText(ref.fragment)}`;
  }
  return { to: u, location };
};

// Whether the key goes with a hop from one URL to another.
//
// The host is the recipient: the key was given to one server, and a hop that
// names another server is giving it to somebody who never asked for it. Only the
// host name is compared, and that is a trust assumption rather than a check:
// the Go build's rule is net/http's, which compares host names and leaves the
// port out of it, so a hop that changes the port is taken to be the same server
// reached another way. Whether the connection still protects what is sent over
// it is keepsCredential's question to answer.
export const forwardsCredential = (from: URL, to: URL): boolean =>
  hostName(from) === hostName(to) && keepsCredential(to.href);

const withoutCredential = (headers: Headers, from: URL, to: URL): Headers => {
  if (forwardsCredential(from, to)) return headers;
  const kept = new Headers(headers);
  kept.delete("Authorization");
  return kept;
};

// Whether a 3xx turns the request into a read.
//
// Every client follows net/http here: 301, 302 and 303 answer a write with a
// GET and no body, because the redirect target is a route that answers GET and
// replaying the write against it would either fail or do the wrong thing. 307
// and 308 keep both, which is why the body has to be replayable: the generated
// client always sends a serialized string.
const downgradeToGet = (status: number, method: string): boolean =>
  (status === 301 || status === 302 || status === 303) && method !== "GET" && method !== "HEAD";

// Builds the failure a body reports, or undefined when it reports none. An
// error status always fails, even without the envelope, because the status is
// the server's verdict.
//
// The envelope is read from the body as it came, as Go's decodeErrorEnvelope
// unmarshalled the raw bytes: JSON allows only space, tab and line breaks
// around a value, so a body wrapped in anything else TrimSpace removes is not
// one. The error keeps the trimmed body, which is what Go's Error.Body held.
const failure = (
  method: string,
  path: string,
  status: number,
  raw: string,
  trimmed: string,
  blob: boolean,
  scrub: (s: string) => string,
): KaneoApiError | undefined => {
  // A blob route's 2xx body is bytes by definition, so a document shaped
  // like the failure envelope is the file being served — an asset can be a
  // JSON file whose contents say success:false — not a report. The envelope
  // still speaks for a refused call.
  const envelope = blob && status >= 200 && status < 300 ? undefined : decodeEnvelope(raw);
  if (envelope) {
    return new KaneoApiError(method, path, status, messagesOf(envelope).map(scrub), scrub(trimmed));
  }
  if (status >= 200 && status < 300) return undefined;
  return new KaneoApiError(
    method,
    path,
    status,
    (codedMessage(trimmed) ?? plainMessage(trimmed)).map(scrub),
    scrub(trimmed),
  );
};

// The message of a failure sent as {"message", "code"} JSON, which is how
// Kaneo v2.50 sends every HTTPException (v2.32 sent it as plain text, below;
// the release that changed it is not pinned down), or undefined when the body
// is not that shape. The code is what tells it from the bare {"message": ...}
// of a 500 that carries no reason a caller could decide on. A key beyond the
// four the server's error schema has (a rate limit's `details`, which holds the
// wait) keeps the body shown whole. `issues` and `missingPermissions` stay in
// the error's body: a validation message names the first issue, and a missing
// permission's list is read from there.
const CODED_KEYS = ["message", "code", "issues", "missingPermissions"];

const codedMessage = (text: string): string[] | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (Object.keys(parsed).some((k) => !CODED_KEYS.includes(k))) return undefined;
  const { message, code } = parsed as { message?: unknown; code?: unknown };
  return typeof message === "string" && message !== "" && typeof code === "string" && code !== ""
    ? [message]
    : undefined;
};

// The message of a failure sent as plain text. Kaneo up to v2.32 sends every
// HTTPException that way — its access checks, its "not found"s and, from v2.23,
// its validation failures — so this is the shape most failures arrive in, and a
// caller deciding on the server's message has to find it in `messages` either
// way. Only a short single line of text counts: markup, JSON that is not the
// envelope (a 500's `{"message": ...}`, once codedMessage has declined it), a
// stack or a long body is reported as a body, not matched as a message.
const plainMessage = (text: string): string[] =>
  text === "" || /^[<{[]/.test(text) || text.includes("\n") || new TextEncoder().encode(text).length > BODY_LIMIT
    ? []
    : [text];

// The server's failure shape. The payload is read as raw JSON because the shape
// it arrives in is the server's choice, not this client's: fixed as an array,
// anything else would fail to decode and the server's message would be lost
// behind a complaint about types. The error member is kept as its raw text so
// the message decode can walk its own members in order the same way.
type Envelope = { error?: string };

// A JSON object's members in the order they arrived, duplicates kept, each
// value as its raw text: encoding/json applies every member in order — a later
// duplicate, whatever its case, overwrites the earlier — where JSON.parse
// merges each exact spelling into one and loses the order of the rest. The
// document is already known to parse, so the walk only has to find where each
// value ends.
const jsonMembers = (text: string): { key: string; value: string }[] | undefined => {
  let i = skipJsonSpace(text, 0);
  if (text[i] !== "{") return undefined;
  i++;
  const members: { key: string; value: string }[] = [];
  i = skipJsonSpace(text, i);
  if (text[i] === "}") return members;
  for (;;) {
    i = skipJsonSpace(text, i);
    if (text[i] !== '"') return undefined;
    const keyEnd = skipJsonString(text, i);
    let key: unknown;
    try {
      key = JSON.parse(text.slice(i, keyEnd));
    } catch {
      return undefined;
    }
    i = skipJsonSpace(text, keyEnd);
    if (text[i] !== ":") return undefined;
    const valueStart = skipJsonSpace(text, i + 1);
    const valueEnd = skipJsonValue(text, valueStart);
    members.push({ key: String(key), value: text.slice(valueStart, valueEnd) });
    i = skipJsonSpace(text, valueEnd);
    if (text[i] === ",") {
      i = skipJsonSpace(text, i + 1);
      continue;
    }
    if (text[i] === "}") return members;
    return undefined;
  }
};

// A JSON array's elements as raw texts, or undefined when the text is not one.
const jsonList = (text: string): string[] | undefined => {
  if (text[0] !== "[") return undefined;
  let i = skipJsonSpace(text, 1);
  const elements: string[] = [];
  if (text[i] === "]") return elements;
  for (;;) {
    const start = i;
    i = skipJsonValue(text, i);
    elements.push(text.slice(start, i));
    i = skipJsonSpace(text, i);
    if (text[i] === ",") {
      i = skipJsonSpace(text, i + 1);
      continue;
    }
    if (text[i] === "]") return elements;
    return undefined;
  }
};

const skipJsonSpace = (text: string, i: number): number => {
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  return i;
};

// The index just past the JSON string starting at i.
const skipJsonString = (text: string, i: number): number => {
  for (i++; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === '"') return i + 1;
  }
  return i;
};

// The index just past the JSON value starting at i.
const skipJsonValue = (text: string, i: number): number => {
  const c = text[i]!;
  if (c === '"') return skipJsonString(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '"') {
        i = skipJsonString(text, i) - 1;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return i;
  }
  while (i < text.length && !",}] \t\n\r".includes(text[i]!)) i++;
  return i;
};

// encoding/json matches an object key to a field name through foldName: ASCII
// letters fold to upper case and every other rune to the smallest rune of
// its unicode.SimpleFold orbit. Against the ASCII literals this file compares
// keys with ("success", "error", "message"), a key matches exactly when its
// fold is the literal's own — "SUCCESS", "ERROR", "MESSAGE" — and the only
// non-ASCII runes that can fold onto an ASCII letter are U+017F (long s, onto
// S) and U+212A (the Kelvin sign, onto K). Every other rune folds to a
// non-ASCII value that can never equal them, so the fold leaves it as it is.
const GO_FOLD_ASCII: Record<string, string> = { "\u017F": "S", "\u212A": "K" };

const goFoldName = (key: string): string => {
  let out = "";
  for (const c of key) {
    const code = c.codePointAt(0)!;
    if (code >= 0x61 && code <= 0x7a) out += String.fromCharCode(code - 0x20);
    else if (code < 0x80) out += c;
    else out += GO_FOLD_ASCII[c] ?? c;
  }
  return out;
};

// Go unmarshals the body into {Success *bool `json:"success"`; Error
// json.RawMessage `json:"error"`}: a key matches its field case-insensitively,
// every member is applied in the order it arrived so a later duplicate wins,
// `success` has to be a boolean (or null, which leaves it unset) and `error`
// accepts any JSON value. A `success` of another type — the string "false", a
// number, an object — fails the whole decode, which here means the body is not
// an envelope at all and is reported as a body.
const decodeEnvelope = (text: string): Envelope | undefined => {
  // Spare the parser the plain text and the markup an error status carries.
  if (!/^[ \t\n\r]*\{/.test(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const members = jsonMembers(text);
  if (members === undefined) return undefined;
  let success: boolean | undefined;
  let error: string | undefined;
  for (const { key, value } of members) {
    const folded = goFoldName(key);
    if (folded === "SUCCESS") {
      let v: unknown;
      try {
        v = JSON.parse(value);
      } catch {
        return undefined;
      }
      if (v === null) {
        success = undefined;
        continue;
      }
      if (typeof v !== "boolean") return undefined;
      success = v;
    } else if (folded === "ERROR") {
      error = value;
    }
  }
  if (success !== false) return undefined;
  return { error };
};

// Whatever human-readable text the failure carries, whichever shape it came in.
// Go tries the error as an array of {message} objects, then as one object, then
// as a string, and the first decode that succeeds answers — an array whose any
// element cannot be a {message} object fails as a whole rather than keeping the
// elements that could.
const messagesOf = (envelope: Envelope): string[] => {
  const { error } = envelope;
  if (error === undefined) return [];
  const first = error[0]!;
  if (first === "[") {
    const elements = jsonList(error);
    if (elements !== undefined) {
      const list: string[] = [];
      let decodes = true;
      for (const element of elements) {
        const message = structMessage(element);
        if (message === undefined) {
          decodes = false;
          break;
        }
        if (message !== "") list.push(message);
      }
      if (decodes) return list;
    }
    // An array that is not a list of {message} objects decodes as neither the
    // struct nor the string, so nothing is left to try.
    return [];
  }
  if (first === "{") {
    const single = structMessage(error);
    return single !== undefined && single !== "" ? [single] : [];
  }
  if (first === '"') {
    try {
      const s: unknown = JSON.parse(error);
      return typeof s === "string" && s !== "" ? [s] : [];
    } catch {
      return [];
    }
  }
  // null decodes as an empty list of messages; a number or a boolean decodes
  // as nothing at all.
  return [];
};

// One {Message string `json:"message"`} decode over a raw JSON text: the key
// matches case-insensitively and every member is applied in the order it
// arrived, a value that is not a string fails the decode (which for an array
// element fails the whole array), and null leaves the field as it was — so an
// absent or only-null message decodes to the empty string. Null itself decodes
// to the zero struct.
const structMessage = (text: string): string | undefined => {
  if (text === "null") return "";
  const members = jsonMembers(text);
  if (members === undefined) return undefined;
  let message: string | undefined;
  for (const { key, value } of members) {
    if (goFoldName(key) !== "MESSAGE") continue;
    if (value === "null") continue;
    if (value[0] !== '"') return undefined;
    try {
      message = JSON.parse(value) as string;
    } catch {
      return undefined;
    }
  }
  return message ?? "";
};
// PUTs the bytes of a staged upload to the presigned URL the server issued.
//
// The URL is not Kaneo's: it carries no API key and answers to no schema, so
// only its status is judged. It is bounded by the same --timeout every other
// request is, since a storage endpoint that never answers would otherwise hold
// the command open for ever. A redirect is refused rather than followed, as
// kaneoFetch refuses its own: the signature is bound to this URL, and the
// bytes and credential would otherwise go wherever it points. The query is
// never repeated in a failure: a presigned URL's query is its credential.
export const putUpload = async (url: string, headers: Record<string, string>, body: Uint8Array): Promise<void> => {
  // The signed query and headers are the credential and the bytes the
  // payload, so the URL is held to the rule the API key is: https, or http
  // to a loopback host. Checked before the request, so nothing leaves the
  // process on a plain-HTTP hop.
  const parsed = parseUrl(url);
  const allowed =
    parsed !== undefined &&
    (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(hostName(parsed))));
  if (!allowed) {
    throw new Error(`upload to storage refused: ${presignedTarget(url)} is not https, or http to a loopback host`);
  }
  const cap = settings.timeoutMs > 0 ? AbortSignal.timeout(settings.timeoutMs) : AbortSignal.abort();
  let response: Response;
  try {
    response = await fetch(url, { method: "PUT", headers, body, signal: cap, redirect: "manual" });
  } catch (e) {
    // A transport error's own wording can quote the request URL, and a
    // presigned URL's query is the upload's credential, so only the failure's
    // kind is repeated — the cause keeps the detail for anyone reading it.
    const kind = e instanceof Error && e.name !== "" ? e.name : "Error";
    throw new Error(`upload to storage failed: ${kind}`, { cause: e });
  }
  if (!response.ok) throw new Error(`upload to storage failed: HTTP ${response.status}`);
};

// The wait better-auth's rate limiter asks for, in milliseconds, from a 429's
// body ({"code":"RATE_LIMITED","details":{"tryAgainIn":38153}}), or undefined
// when the body does not say.
const tryAgainIn = (bytes: ArrayBuffer): number | undefined => {
  try {
    const reply = JSON.parse(new TextDecoder().decode(bytes));
    // Only the limiter's own answer: other 429s (a label being deleted, an
    // import already running) are not a wait the request can sit out.
    if (reply?.code !== "RATE_LIMITED") return undefined;
    const wait = reply?.details?.tryAgainIn;
    return typeof wait === "number" && Number.isFinite(wait) && wait >= 0 ? wait : undefined;
  } catch {
    return undefined;
  }
};

// A PUT to a presigned storage URL, the middle of an upload the server
// prepared: not a Kaneo request, so it gets no /api prefix, no key and no
// JSON — only the headers the server signed for it, and the same per-request
// timeout every other call gets. The URL's query can carry the signature that
// authorizes it, so a failure names where it went without it.
export const presignedPut = async (url: string, headers: Record<string, string>, body: Uint8Array): Promise<void> => {
  const target = presignedTarget(url);
  // The signed query and headers are the credential and the bytes the
  // payload, so the URL is held to the rule the API key is: https, or http
  // to a loopback instance. Checked before the request, so nothing leaves
  // the process on a plain-HTTP hop.
  const parsed = parseUrl(url);
  const allowed =
    parsed !== undefined &&
    (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(hostName(parsed))));
  if (!allowed) {
    throw new Error(
      `PUT ${target}: refusing to send the upload over a URL that is not https, or http to a loopback host`,
    );
  }
  const cap = settings.timeoutMs > 0 ? AbortSignal.timeout(settings.timeoutMs) : AbortSignal.abort();
  let response: Response;
  try {
    // Followed by hand for the same reason kaneoFetch does: a redirect would
    // resend the signed headers and body to a host the signature was not
    // written for, or turn the PUT into a GET that answers 200 and reads as
    // an upload that never landed. A 3xx is a failure, as it is there.
    response = await fetch(url, { method: "PUT", headers, body, signal: cap, redirect: "manual" });
  } catch (e) {
    throw new Error(`PUT ${target}: ${reason(e)}`, { cause: e });
  }
  // Read either way: an error's body is the report, and a success's is small
  // enough that leaving it unread would only hold the connection open.
  const text = await response.text().catch(() => "");
  if (response.ok) return;
  const shown = storageError(text);
  throw new Error(`PUT ${target}: ${response.status}${shown === "" ? "" : `: ${shown}`}`);
};

// What a storage server's refusal is allowed to say back. An S3-style XML
// error puts the signature it checked beside the code and message
// (<StringToSign>, <SignatureProvided>), which must not reach the terminal,
// so only those two fields are lifted out of markup; markup without them is
// withheld rather than echoed. Any other body is shown bounded, as it was:
// a plain error is its whole report.
const storageError = (body: string): string => {
  const trimmed = body.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("<")) {
    const shown = [xmlField(trimmed, "Code"), xmlField(trimmed, "Message")].filter((s) => s !== "").join(": ");
    return shown;
  }
  return trimmed.length > BODY_LIMIT ? `${trimmed.slice(0, BODY_LIMIT)}...` : trimmed;
};

// The text of one element of a markup error body, "" when it is not there.
// The element's text cannot hold a raw "<" (it would be &lt;), so the match
// stops at the first one, which is its own closing tag.
const xmlField = (body: string, name: string): string => {
  const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1];
  return found === undefined ? "" : xmlText(found);
};

// The five entities XML defines by name, which is all an error field carries.
const xmlText = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!);

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Where a presigned PUT went, without the query that authorizes it.
const presignedTarget = (url: string): string => {
  try {
    const target = new URL(url);
    return `${target.origin}${target.pathname}`;
  } catch {
    // Unparseable or not, the query is where a signature would sit.
    return url.split(/[?#]/)[0]!;
  }
};

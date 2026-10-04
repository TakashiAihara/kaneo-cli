import type { ZodError, ZodType } from "zod";
import { OPERATIONS, type Operation } from "./registry";

// The transport under the generated client. Every generated call goes through
// kaneoFetch, so the key is checked, attached and reported on the same way for
// every operation, and every response is checked against the schema the
// generator passes in. Behaviour is pinned by tests/http.test.ts.
export type KaneoInit<T> = RequestInit & { schema?: ZodType<T> };

type ClientConfig = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  // The budget every request of the running command shares. Applied to each of
  // them rather than to one, which is the difference between a command that
  // times out once and a command whose four lookups each get the full timeout.
  deadline?: AbortSignal;
  // KANEO_DEBUG is the switch the documentation names; taking it here as well
  // means the transport reports what it saw without every caller having to
  // remember to pass the flag on.
  debug?: boolean;
};

type Settings = Required<Omit<ClientConfig, "deadline">> & { deadline: AbortSignal | undefined };

// Bounds a single request, as the Go build's DefaultTimeout did.
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
// A message is read on a terminal, so a long raw body is cut; the error keeps
// the whole of it for whoever wants to look closer.
const BODY_LIMIT = 200;

let settings: Settings = { baseUrl: "", apiKey: "", timeoutMs: DEFAULT_TIMEOUT_MS, deadline: undefined, debug: false };

// Called once per process, before the first generated call. The transport is a
// module the generated client imports, so there is no other way to hand it the
// settings it needs.
export const configureClient = (config: ClientConfig): void => {
  settings = {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: config.apiKey ?? "",
    timeoutMs: config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    deadline: config.deadline,
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

// Raised instead of sending the key where TLS is not protecting it. The check
// runs before the request, so nothing leaves the process, and the message names
// the target but never the key.
export class InsecureCredentialError extends Error {
  constructor(public readonly target: string) {
    super(
      `${target}: refusing to send the API key over plain HTTP; use https, or a loopback address for a local instance`,
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
    super(describeFailure(method, path, statusCode, messages, body));
  }

  // Reports whether the call failed because the key was rejected, which the
  // commands answer with a hint about where the key comes from rather than by
  // repeating the server's wording.
  unauthorized(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
}

const describeFailure = (
  method: string,
  path: string,
  status: number,
  messages: string[],
  body: string,
): string => {
  if (messages.length > 0) return `${method} ${path}: ${status}: ${messages.join("; ")}`;
  // The body comes trimmed as Go's TrimSpace trims it; trimming it again here
  // would drop a byte order mark Go kept in its Error.Body.
  if (body === "") return `${method} ${path}: ${status}`;
  const shown = body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}...` : body;
  return `${method} ${path}: ${status}: ${shown}`;
};

export const kaneoFetch = async <T>(url: string, init: KaneoInit<T>): Promise<T> => {
  if (settings.baseUrl === "") throw new Error("no API URL configured");

  const { schema, ...request } = init;
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
  // failure names the call that was made rather than the hop that failed.
  const served = servedPath(target);
  let headers = new Headers(request.headers);
  headers.set("Accept", "application/json");
  if (settings.apiKey !== "") {
    if (!keepsCredential(target.href)) {
      throw new InsecureCredentialError(`${target.protocol}//${target.host}`);
    }
    headers.set("Authorization", `Bearer ${settings.apiKey}`);
  }

  // Three things can cut a request short: the budget its command shares with
  // everything else it does, a signal the caller passed to bound this one
  // further, and the cap on any single request. The same deadline covers the
  // redirect chain, so a server that keeps redirecting cannot hold the process
  // open either.
  const cap = AbortSignal.timeout(settings.timeoutMs);
  const signal = AbortSignal.any([settings.deadline, request.signal, cap].filter(isSignal));

  // The method the call was made with, before a 301, 302 or 303 rewrote it into
  // a GET. Failures name it together with served, the pair Go's send reported.
  // The operation is looked up by it as well, so a write turned into a GET is
  // still read as that write's reply, and a whitespace-only one fails to decode
  // as it does without the redirect.
  const called = method;

  let response: Response;
  let location = "";
  for (let hop = 0; ; hop++) {
    // Go's http.Client reports this as it reports a request that got no answer:
    // the call's method and the Location it refused to follow, as the header
    // wrote it rather than resolved. send prefixes the call as for any failure.
    if (hop >= MAX_REDIRECTS) {
      throw new Error(
        `${called} ${served}: ${goOp(called)} ${JSON.stringify(location)}: stopped after ${MAX_REDIRECTS} redirects`,
      );
    }
    try {
      // Followed by hand: only the transport knows whether the next hop may
      // still carry the key, and fetch decides that on its own.
      response = await fetch(target, { method, headers, body, signal, redirect: "manual" });
    } catch (e) {
      throw new Error(`${called} ${served}: ${urlError(called, target, e)}`, { cause: e });
    }
    const next = redirectTarget(response, target);
    if (!next) break;
    location = response.headers.get("location") ?? "";
    // The key stays only where it would still be protected and where it was
    // already meant to go; a hop to an insecure host, or to another one, goes
    // on without it and the server decides.
    headers = withoutCredential(headers, target, next);
    // 301, 302 and 303 turn a write into a GET the way every other client
    // does, or the write would be replayed against a route that does not take
    // it. 307 and 308 keep the method and body, which is why the body has to
    // be replayable: the generated client always sends a serialized string.
    if (downgradeToGet(response.status, method)) {
      method = "GET";
      body = null;
      headers.delete("content-type");
    }
    target = next;
  }

  let bytes: ArrayBuffer;
  try {
    // Read as bytes, because both decisions made from the body are the Go
    // build's: it judged an empty reply by its length in bytes and reported the
    // length in bytes when a reply failed to decode, neither of which is what a
    // string of the same reply would measure.
    bytes = await response.arrayBuffer();
  } catch (e) {
    throw new Error(`${called} ${served}: read body: ${reason(e)}`, { cause: e });
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
  const reported = failure(called, served, response.status, text, trimmed);
  if (reported) throw reported;

  // Which of the Go build's two request paths this is, which its two parsers
  // were told apart by as well: a reply the generated client read is decoded and
  // named after the operation it was read into, and the one request this CLI
  // issues without the generated client (the server's own document, for
  // api-check) is trimmed first and reported the way Client.Do reported it.
  const operation = operationAt(called, path);

  // A write that reports 204 has nothing to decode, and the generated types
  // say so by having nothing to return. What counts as empty is the Go build's
  // answer: a body of no bytes at all, so a 2xx carrying only whitespace is not
  // a reply to return zero values for but one that failed to decode, which is
  // what stopped the command there.
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
      operation === undefined
        ? `decode response: ${why}`
        : decodeFailure(response, bytes.byteLength, operation, why);
    throw new Error(`${called} ${served}: ${what}`, { cause: e });
  }
  if (schema) {
    const checked = schema.safeParse(decoded);
    // A deployed server older than the document omits fields the document
    // declares (backgroundVersion on a project, seen on a live instance on
    // 2026-10-03). The Go build decoded those leniently, so the body comes
    // back as it was sent and the mismatch is only worth mentioning when
    // somebody asked to see it.
    if (!checked.success && settings.debug) {
      reportMismatch(called, path, checked.error);
    }
  }
  return decoded as T;
};

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// What Go's strings.TrimSpace removes: Unicode's White_Space. That is what
// JavaScript's trim() removes except for two characters: it also counts the byte
// order mark, which would turn a reply holding nothing else into the empty one
// where Go read it as a body that failed to decode, and it leaves NEL (U+0085).
const goTrimSpace = (text: string): string =>
  text.replace(/^(?:[^\S\uFEFF]|\u0085)+|(?:[^\S\uFEFF]|\u0085)+$/g, "");

const isSignal = (signal: AbortSignal | null | undefined): signal is AbortSignal =>
  signal !== undefined && signal !== null;

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
const goDecodeReason = (why: string): string =>
  why.includes("Unexpected EOF") ? "unexpected end of JSON input" : why;

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
const urlError = (method: string, target: URL, e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return `${goOp(method)} ${JSON.stringify(target.href)}: ${dialReason(target, code, e)}`;
};

// A method as url.Error names it. Go's client takes it from the first request of
// a redirect chain, so a write turned into a GET by a 303 is still a Post there.
const goOp = (method: string): string =>
  method === "" ? "Get" : method.slice(0, 1) + method.slice(1).toLowerCase();

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
    // Both aborts are a deadline: the only signal this CLI ever passes in is
    // the command's timeout, and Go reports that as a deadline exceeded.
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
  console.error(
    `kaneo: ${method} ${path}: response does not match the schema, returned as sent: ${fields}`,
  );
};

const redirectTarget = (response: Response, from: URL): URL | undefined => {
  if (!REDIRECT_STATUSES.includes(response.status)) return undefined;
  const location = response.headers.get("location");
  if (!location) return undefined;
  // Resolved against the URL that answered it, the way any other client would.
  // A Location that is not a URL counts as no redirect, leaving the 3xx to be
  // reported as the failure it is.
  try {
    return new URL(location, from);
  } catch {
    return undefined;
  }
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
): KaneoApiError | undefined => {
  const envelope = decodeEnvelope(raw);
  if (envelope) return new KaneoApiError(method, path, status, messagesOf(envelope), trimmed);
  if (status >= 200 && status < 300) return undefined;
  return new KaneoApiError(method, path, status, plainMessage(trimmed), trimmed);
};

// The message of a failure sent as plain text. The server sends every
// HTTPException that way — its access checks, its "not found"s and, from v2.23,
// its validation failures — so this is the shape most failures arrive in, and a
// caller deciding on the server's message has to find it in `messages` either
// way. Only a short single line of text counts: markup, JSON that is not the
// envelope (a 500's `{"message": ...}`), a stack or a long body is reported as a
// body, not matched as a message.
const plainMessage = (text: string): string[] =>
  text === "" || /^[<{[]/.test(text) || text.includes("\n") || text.length > BODY_LIMIT ? [] : [text];

// The server's failure shape. The payload is read as raw JSON because the shape
// it arrives in is the server's choice, not this client's: fixed as an array,
// anything else would fail to decode and the server's message would be lost
// behind a complaint about types.
type Envelope = { error?: unknown };

const decodeEnvelope = (text: string): Envelope | undefined => {
  // Spare the parser the plain text and the markup an error status carries.
  if (!/^[ \t\n\r]*\{/.test(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const envelope = parsed as { success?: unknown; error?: unknown };
  return envelope.success === false ? { error: envelope.error } : undefined;
};

// Whatever human-readable text the failure carries, whichever shape it came in.
const messagesOf = (envelope: Envelope): string[] => {
  const { error } = envelope;
  if (error === undefined || error === null) return [];
  if (Array.isArray(error)) {
    return error.map(messageOf).filter((m) => m !== "");
  }
  const single = messageOf(error);
  if (single !== "") return [single];
  if (typeof error === "string" && error !== "") return [error];
  return [];
};

const messageOf = (value: unknown): string => {
  if (value === null || typeof value !== "object") return "";
  const { message } = value as { message?: unknown };
  return typeof message === "string" ? message : "";
};
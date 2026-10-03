import type { ZodError, ZodType } from "zod";

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

// A failed API call. The message names the request so it can be pasted into
// curl as it is, and the fields are there so a command can say more than the
// message does.
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
  const text = body.trim();
  if (text === "") return `${method} ${path}: ${status}`;
  const shown = text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}...` : text;
  return `${method} ${path}: ${status}: ${shown}`;
};

export const kaneoFetch = async <T>(url: string, init: KaneoInit<T>): Promise<T> => {
  if (settings.baseUrl === "") throw new Error("no API URL configured");

  const { schema, ...request } = init;
  // The endpoint as the generated client wrote it, query included. A failure
  // with a status quotes this, because that is the call that was made; one
  // without a status quotes the path it was served on, which is servedPath's.
  const path = url;

  let method = (request.method ?? "GET").toUpperCase();
  let body = request.body ?? null;
  let target = new URL(settings.baseUrl + url);
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

  let response: Response;
  for (let hop = 0; ; hop++) {
    if (hop >= MAX_REDIRECTS) throw new Error(`stopped after ${MAX_REDIRECTS} redirects`);
    try {
      // Followed by hand: only the transport knows whether the next hop may
      // still carry the key, and fetch decides that on its own.
      response = await fetch(target, { method, headers, body, signal, redirect: "manual" });
    } catch (e) {
      throw new Error(`${method} ${servedPath(target)}: ${urlError(method, target, e)}`, { cause: e });
    }
    const next = redirectTarget(response, target);
    if (!next) break;
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

  let raw: string;
  try {
    raw = await response.text();
  } catch (e) {
    throw new Error(`${method} ${path}: read body: ${reason(e)}`, { cause: e });
  }
  const text = raw.trim();

  // A non-2xx status and a 2xx carrying success:false are both failures: the
  // server reports validation problems the second way, so the status alone is
  // not enough to judge the call.
  const reported = failure(method, path, response.status, text);
  if (reported) throw reported;
  // A write that reports 204 has nothing to decode, and the generated types
  // say so by having nothing to return.
  if (text === "") return undefined as T;

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (e) {
    throw new Error(`${method} ${path}: decode response: ${reason(e)}`, { cause: e });
  }
  if (schema) {
    const checked = schema.safeParse(decoded);
    // A deployed server older than the document omits fields the document
    // declares (backgroundVersion on a project, seen on a live instance on
    // 2026-10-03). The Go build decoded those leniently, so the body comes
    // back as it was sent and the mismatch is only worth mentioning when
    // somebody asked to see it.
    if (!checked.success && settings.debug) {
      reportMismatch(method, path, checked.error);
    }
  }
  return decoded as T;
};

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isSignal = (signal: AbortSignal | null | undefined): signal is AbortSignal =>
  signal !== undefined && signal !== null;

// The path a request was made on, as the server saw it: /api included, percent-
// escapes read back and the query left out. A call that never got an answer is
// reported this way because there is no status to report instead, and the
// address is what can be put into curl to try it by hand.
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
  const op = method === "" ? "Get" : method.slice(0, 1) + method.slice(1).toLowerCase();
  return `${op} ${JSON.stringify(target.href)}: ${dialReason(target, code, e)}`;
};

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

// Whether the redirect is still talking to the host the key was handed to, and
// still over a connection that protects it.
//
// The host is the recipient: the key was given to one server, and a hop that
// names another server is giving it to somebody who never asked for it. Only the
// host name is compared, because a redirect that moves the port, or the scheme,
// is the same server reached another way, and whether the transport is still
// safe is keepsCredential's question to answer.
const withoutCredential = (headers: Headers, from: URL, to: URL): Headers => {
  if (hostName(from) === hostName(to) && keepsCredential(to.href)) return headers;
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
const failure = (method: string, path: string, status: number, text: string): KaneoApiError | undefined => {
  const envelope = decodeEnvelope(text);
  if (envelope) return new KaneoApiError(method, path, status, messagesOf(envelope), text);
  if (status >= 200 && status < 300) return undefined;
  return new KaneoApiError(method, path, status, [], text);
};

// The server's failure shape. The payload is read as raw JSON because the shape
// it arrives in is the server's choice, not this client's: fixed as an array,
// anything else would fail to decode and the server's message would be lost
// behind a complaint about types.
type Envelope = { error?: unknown };

const decodeEnvelope = (text: string): Envelope | undefined => {
  // Spare the parser the plain text and the markup an error status carries.
  if (!text.startsWith("{")) return undefined;
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
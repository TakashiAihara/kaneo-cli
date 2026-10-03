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
  // KANEO_DEBUG is the switch the documentation names; taking it here as well
  // means the transport reports what it saw without every caller having to
  // remember to pass the flag on.
  debug?: boolean;
};

type Settings = Required<ClientConfig>;

// Bounds a single request, as the Go build's DefaultTimeout did.
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
// A message is read on a terminal, so a long raw body is cut; the error keeps
// the whole of it for whoever wants to look closer.
const BODY_LIMIT = 200;

let settings: Settings = { baseUrl: "", apiKey: "", timeoutMs: DEFAULT_TIMEOUT_MS, debug: false };

// Called once per process, before the first generated call. The transport is a
// module the generated client imports, so there is no other way to hand it the
// settings it needs.
export const configureClient = (config: ClientConfig): void => {
  settings = {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: config.apiKey ?? "",
    timeoutMs: config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
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
  return url.protocol === "https:" || isLoopback(url.hostname);
};

const parseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
};

const isLoopback = (hostname: string): boolean => {
  // A URL keeps an IPv6 host in brackets; Go's url.Hostname does not.
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost") return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // The whole of 127.0.0.0/8, which is what net.IP.IsLoopback counts.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
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
  // The path is kept as the caller wrote it, query included: a message quoting
  // it reads as the call that was made.
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

  // One deadline covers the whole chain, so a server that keeps redirecting
  // cannot hold the process open.
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  let response: Response;
  for (let hop = 0; ; hop++) {
    if (hop >= MAX_REDIRECTS) throw new Error(`stopped after ${MAX_REDIRECTS} redirects`);
    try {
      // Followed by hand: only the transport knows whether the next hop may
      // still carry the key, and fetch decides that on its own.
      response = await fetch(target, { method, headers, body, signal, redirect: "manual" });
    } catch (e) {
      throw new Error(`${method} ${path}: ${reason(e)}`, { cause: e });
    }
    const next = redirectTarget(response, target);
    if (!next) break;
    // The key stays only where it would still be protected; a hop to an
    // insecure target goes on without it and the server decides.
    headers = withoutCredential(headers, next);
    // 301, 302 and 303 turn a write into a GET the way every other client
    // does, or the write would be replayed against a route that does not take
    // it. 307 and 308 keep the method and body, which is why the body has to
    // be replayable: the generated client always sends a serialized string.
    const downgrade = downgradeToGet(response.status, method);
    if (downgrade) {
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

const withoutCredential = (headers: Headers, target: URL): Headers => {
  if (keepsCredential(target.href)) return headers;
  const kept = new Headers(headers);
  kept.delete("Authorization");
  return kept;
};

const downgradeToGet = (status: number, method: string): boolean =>
  (status === 303 && method !== "GET" && method !== "HEAD") ||
  ((status === 301 || status === 302) && method === "POST");

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
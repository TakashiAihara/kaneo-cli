import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  configureClient,
  forwardsCredential,
  InsecureCredentialError,
  kaneoFetch,
  KaneoApiError,
  keepsCredential,
  normalizeBaseUrl,
  presignedPut,
} from "../src/api/http";

// The contract of the transport under the generated client, ported from the
// Go build's internal/api/client_test.go. Every generated operation goes
// through kaneoFetch, so these hold for all of them.

type Handler = (req: Request) => Response | Promise<Response>;
const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});
const serve = (handler: Handler) => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail, and it succeeded");
};

const captureStderr = async (fn: () => Promise<unknown>) => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
};

describe("normalizeBaseUrl", () => {
  // The site root serves the web app and answers 200 with HTML for any path,
  // so a base that misses /api looks like a success that returns markup.
  test.each([
    ["https://kaneo.example", "https://kaneo.example/api"],
    ["https://kaneo.example/", "https://kaneo.example/api"],
    ["https://kaneo.example/api", "https://kaneo.example/api"],
    ["https://kaneo.example/api/", "https://kaneo.example/api"],
    ["  https://kaneo.example  ", "https://kaneo.example/api"],
    ["", ""],
  ])("%p -> %p", (input, want) => {
    expect(normalizeBaseUrl(input)).toBe(want);
  });
});

describe("requests", () => {
  test("land under the /api prefix and carry the key as a bearer token", async () => {
    let seen = { path: "", auth: "" };
    const url = serve((req) => {
      const u = new URL(req.url);
      seen = { path: u.pathname + u.search, auth: req.headers.get("authorization") ?? "" };
      return Response.json([]);
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    await kaneoFetch("/project?workspaceId=ws", { method: "GET" });
    expect(seen).toEqual({ path: "/api/project?workspaceId=ws", auth: "Bearer test-key" });
  });

  test("marked anonymous neither ask for the key nor send it", async () => {
    const auths: string[] = [];
    const url = serve((req) => {
      auths.push(req.headers.get("authorization") ?? "none");
      return Response.json({});
    });
    let asked = 0;
    configureClient({ baseUrl: url, apiKey: () => (asked++, "fetched-key") });
    await kaneoFetch("/openapi", { method: "GET", anonymous: true });
    expect({ asked, auths }).toEqual({ asked: 0, auths: ["none"] });

    // The same transport, unmarked, does ask and send: the marker is what kept it out.
    await kaneoFetch("/user/me", { method: "GET" });
    expect({ asked, auths }).toEqual({ asked: 1, auths: ["none", "Bearer fetched-key"] });
  });

  test("send the body the generated client built, unchanged", async () => {
    let got = { method: "", body: "" };
    const url = serve(async (req) => {
      got = { method: req.method, body: await req.text() };
      return Response.json({});
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    await kaneoFetch("/task/status/t1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in-progress" }),
    });
    expect(got).toEqual({ method: "PUT", body: '{"status":"in-progress"}' });
  });

  test("give up after the configured timeout", async () => {
    const url = serve(() => new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json([])), 2000)));
    configureClient({ baseUrl: url, apiKey: "test-key", timeoutMs: 100 });
    const started = Date.now();
    await failure(kaneoFetch("/project", { method: "GET" }));
    expect(Date.now() - started).toBeLessThan(1500);
  });

  // The budget bounds one request, and every request gets the whole of it, so a
  // board that takes several pages is read at the pace of one that fits in a
  // page. Zero or less is not the default and not no timeout either: it is a
  // budget that has already run out, so every request under it fails at once.
  test.each([
    ["zero", 0],
    ["negative", -1_000],
  ])("fail every request at once when the timeout is %s", async (_name, timeoutMs) => {
    let reached = 0;
    const url = serve(() => {
      reached++;
      return Response.json([]);
    });
    configureClient({ baseUrl: url, apiKey: "test-key", timeoutMs });
    for (const attempt of [1, 2]) {
      const e = (await failure(kaneoFetch("/project", { method: "GET" }))) as Error;
      expect(e.message, `request ${attempt}`).toContain("context deadline exceeded");
    }
    expect(reached).toBe(0);
  });
});

describe("the key over plain HTTP", () => {
  // Checked before the request, so nothing leaves the process.
  test("is refused with InsecureCredentialError, without the key in the message", async () => {
    configureClient({ baseUrl: "http://kaneo.example.invalid", apiKey: "very-private-value" });
    const e = await failure(kaneoFetch("/project", { method: "GET" }));
    expect(e).toBeInstanceOf(InsecureCredentialError);
    const message = String((e as Error).message);
    expect(message).toContain("plain HTTP");
    expect(message).toContain("loopback");
    expect(message).not.toContain("very-private-value");
  });

  test("is not refused when there is no key", async () => {
    configureClient({ baseUrl: "http://kaneo.example.invalid", apiKey: "" });
    const e = await failure(kaneoFetch("/project", { method: "GET" }));
    expect(e).not.toBeInstanceOf(InsecureCredentialError);
  });

  test("is sent to a loopback instance", async () => {
    let auth = "";
    const url = serve((req) => {
      auth = req.headers.get("authorization") ?? "";
      return Response.json([]);
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    await kaneoFetch("/project", { method: "GET" });
    expect(auth).toBe("Bearer test-key");
  });
});

// The calendar feed's token is in the URL path, so its request is anonymous —
// no key is fetched or sent — yet the URL still owes keepsCredential's
// protection: plain HTTP to a non-loopback host is refused before anything is
// sent, and so is a redirect that lands on one, since the path cannot be
// stripped the way the key's header can.
describe("a credential carried in the URL", () => {
  const feedInit = { method: "GET", anonymous: true, text: true, credentialInUrl: true };

  test("is refused over plain HTTP to a non-loopback host, without asking for the key", async () => {
    let asked = 0;
    configureClient({ baseUrl: "http://kaneo.example.invalid", apiKey: () => (asked++, "test-key") });
    const e = await failure(kaneoFetch<string>("/calendar-feed/t/calendar.ics", feedInit));
    expect(e).toBeInstanceOf(InsecureCredentialError);
    expect(asked).toBe(0);
  });

  test("is sent to a loopback instance", async () => {
    const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
    const url = serve(() => new Response(ics, { headers: { "content-type": "text/calendar" } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    expect(await kaneoFetch<string>("/calendar-feed/t/calendar.ics", feedInit)).toBe(ics);
  });

  test("a redirect to plain HTTP off-loopback is refused", async () => {
    const origin = serve(() => Response.redirect("http://kaneo.example.invalid/calendar-feed/t/calendar.ics", 307));
    configureClient({ baseUrl: origin, apiKey: "test-key" });
    const e = (await failure(kaneoFetch<string>("/calendar-feed/t/calendar.ics", feedInit))) as Error;
    expect(e).toBeInstanceOf(InsecureCredentialError);
    expect(e.message).toContain("http://kaneo.example.invalid");
  });

  test("a redirect that stays on protected targets is followed", async () => {
    const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
    const target = serve(() => new Response(ics));
    const origin = serve(() => Response.redirect(`${target}/api/calendar-feed/t/calendar.ics`, 307));
    configureClient({ baseUrl: origin, apiKey: "test-key" });
    expect(await kaneoFetch<string>("/calendar-feed/t/calendar.ics", feedInit)).toBe(ics);
  });
});

describe("redirects", () => {
  // fetch keeps Authorization across a same-host redirect even when the
  // scheme drops to http, which would put the key on the wire in the clear.
  test.each([
    ["https://kaneo.example/api", true],
    ["http://kaneo.example/api", false],
    ["http://127.0.0.1:5173/api", true],
    ["http://localhost:5173/api", true],
    ["http://[::1]:5173/api", true],
  ])("keepsCredential(%p) is %p", (target, want) => {
    expect(keepsCredential(target)).toBe(want);
  });

  test("are followed with the key when the target is still secure", async () => {
    let auth = "";
    const target = serve((req) => {
      auth = req.headers.get("authorization") ?? "";
      return Response.json([]);
    });
    const origin = serve(() => Response.redirect(`${target}/api/project`, 307));
    configureClient({ baseUrl: origin, apiKey: "test-key" });
    await kaneoFetch("/project", { method: "GET" });
    expect(auth).toBe("Bearer test-key");
  });

  // The whole rule in one place, so each half of it is pinned: the host must
  // stay the same, and the hop must still be protected.
  test.each([
    ["https://kaneo.example/api", "https://kaneo.example/api/x", true],
    ["https://kaneo.example/api", "https://kaneo.example:8443/api/x", true],
    ["https://kaneo.example/api", "http://kaneo.example/api/x", false],
    ["https://kaneo.example/api", "https://other.example/api/x", false],
    ["https://kaneo.example/api", "https://KANEO.example/api/x", true],
    ["http://127.0.0.1:5173/api", "http://127.0.0.1:5174/api/x", true],
    ["http://127.0.0.1:5173/api", "http://localhost:5173/api/x", false],
    ["http://[::1]:5173/api", "http://[::1]:5174/api/x", true],
  ])("forwardsCredential(%p, %p) is %p", (from, to, want) => {
    expect(forwardsCredential(new URL(from), new URL(to))).toBe(want);
  });

  // A redirect to another host is a different recipient, whatever its scheme:
  // the Go build's client dropped the key there, and so must this one.
  test("drop the key when the redirect changes host", async () => {
    let auth = "unset";
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        auth = req.headers.get("authorization") ?? "";
        return Response.json([]);
      },
    });
    servers.push(target);
    const origin = serve(() => Response.redirect(`http://localhost:${target.port}/api/project`, 307));
    configureClient({ baseUrl: origin, apiKey: "test-key" });
    await kaneoFetch("/project", { method: "GET" });
    expect(auth).toBe("");
  });

  // Go's client refuses the eleventh request, so the server sees ten.
  test("stop after 10 hops", async () => {
    let hops = 0;
    const url = serve((req) => {
      hops++;
      return Response.redirect(new URL(req.url).toString(), 307);
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project", { method: "GET" }))) as Error;
    expect(hops).toBe(10);
    expect(e.message).toBe(`GET /api/project: Get ${JSON.stringify(`${url}/api/project`)}: stopped after 10 redirects`);
  });

  // As Go's client does: 301, 302 and 303 turn any method but GET and HEAD
  // into a GET without a body; 307 and 308 keep both. The redirect stays on
  // the origin the request was sent to: a body may not be replayed anywhere
  // else, which the refusal tests below pin.
  test.each([
    [301, "PUT", "GET", ""],
    [302, "PUT", "GET", ""],
    [303, "PUT", "GET", ""],
    [301, "POST", "GET", ""],
    [303, "DELETE", "GET", ""],
    [307, "PUT", "PUT", '{"status":"done"}'],
    [308, "POST", "POST", '{"status":"done"}'],
  ])("a %p answered to %p is followed as %p", async (status, method, want, wantBody) => {
    let got = { method: "", body: "" };
    const url = serve(async (req) => {
      if (new URL(req.url).pathname === "/api/task/status/t1") {
        return new Response(null, { status, headers: { location: "/api/elsewhere" } });
      }
      got = { method: req.method, body: await req.text() };
      return Response.json({});
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    await kaneoFetch("/task/status/t1", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(got).toEqual({ method: want, body: wantBody });
  });

  // The body is the credential the headers cannot show: the GitLab token an
  // integration call sends travels inside it. A hop that would replay it
  // against another origin is refused before the request is made, and the
  // target never sees it.
  test.each([307, 308])("refuse a %p to another origin when the request has a body", async (status) => {
    let reached = 0;
    const target = serve(() => {
      reached++;
      return Response.json({});
    });
    const origin = serve(() => new Response(null, { status, headers: { location: `${target}/api/elsewhere` } }));
    configureClient({ baseUrl: origin, apiKey: "test-key" });
    const e = (await failure(
      kaneoFetch("/gitlab-integration/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: "gitlab-token" }),
      }),
    )) as KaneoApiError;
    expect(e).toBeInstanceOf(KaneoApiError);
    expect(e.statusCode).toBe(status);
    expect(e.message).toBe(
      `POST /api/gitlab-integration/verify: ${status}: refusing to follow the redirect to ${target}/api/elsewhere: the request body may carry a credential`,
    );
    expect(reached).toBe(0);
  });

  // The same hop on the origin the request was sent to is followed with the
  // body intact: the credential stays with the server it was meant for.
  test("follow a 307 on the same origin with the body", async () => {
    let got = { method: "", body: "", auth: "" };
    const url = serve(async (req) => {
      if (new URL(req.url).pathname === "/api/gitlab-integration/verify") {
        return new Response(null, { status: 307, headers: { location: "/api/elsewhere" } });
      }
      got = { method: req.method, body: await req.text(), auth: req.headers.get("authorization") ?? "" };
      return Response.json({});
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    await kaneoFetch("/gitlab-integration/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: "gitlab-token" }),
    });
    expect(got).toEqual({ method: "POST", body: '{"accessToken":"gitlab-token"}', auth: "Bearer test-key" });
  });

  // The origin a body may be replayed to is the scheme, host and port together:
  // a hop that keeps the host and port but changes the scheme is another
  // recipient, so an https-to-http downgrade — or the upgrade shown here, the
  // comparison being symmetric — is refused before the request is attempted.
  test("refuse a redirect that changes only the scheme when the request has a body", async () => {
    let hits = 0;
    const url = serve((req) => {
      hits++;
      const secure = new URL(req.url);
      secure.protocol = "https:";
      return new Response(null, { status: 307, headers: { location: secure.href } });
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(
      kaneoFetch("/gitlab-integration/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: "gitlab-token" }),
      }),
    )) as KaneoApiError;
    expect(e).toBeInstanceOf(KaneoApiError);
    expect(e.statusCode).toBe(307);
    expect(e.message).toBe(
      `POST /api/gitlab-integration/verify: 307: refusing to follow the redirect to ${url.replace("http:", "https:")}/api/gitlab-integration/verify: the request body may carry a credential`,
    );
    expect(hits).toBe(1);
  });

  // The rewrite changes what is sent, not what was asked for: the reply is still
  // read into the operation the call was made for, so a whitespace-only reply to
  // a redirected write fails to decode as it does without the redirect, rather
  // than passing for the empty reply only a hand-issued call's path would call it.
  test.each([
    [301, "PUT", "/task/status/t1", '{"status":"done"}', "UpdateTaskStatusResponse"],
    [302, "PUT", "/task/status/t1", '{"status":"done"}', "UpdateTaskStatusResponse"],
    [303, "POST", "/task-relation", '{"relationType":"blocks"}', "CreateTaskRelationResponse"],
  ])("a %p answered to a %p does not read its reply as the empty one", async (status, method, path, body, wantType) => {
    const server = serve(() => new Response("  \n", { headers: { "content-type": "application/json" } }));
    // Sent to another route, so a failure that named the route it was redirected
    // to, or an operation looked up by it, would read differently.
    const origin = serve(() => new Response(null, { status, headers: { location: `${server}/api/elsewhere` } }));
    configureClient({ baseUrl: origin, apiKey: "test-key" });
    const e = (await failure(
      kaneoFetch(path, { method, headers: { "Content-Type": "application/json" }, body }),
    )) as Error;
    expect(e.message).toContain(`target-type=${wantType}`);
    expect(e.message).toStartWith(`${method} /api${path}: error decoding response`);
  });
});

// A failure after a redirect names the call that was made, as Go's send did:
// the method and route it was called with, whatever hop it was the answer to.
describe("failures after a redirect", () => {
  test("a status from the redirected hop names the call", async () => {
    const server = serve(() => new Response("gone", { status: 404 }));
    const origin = serve(() => new Response(null, { status: 303, headers: { location: `${server}/api/elsewhere` } }));
    configureClient({ baseUrl: origin });
    const e = (await failure(kaneoFetch("/task-relation", { method: "POST", body: "{}" }))) as KaneoApiError;
    expect(e).toBeInstanceOf(KaneoApiError);
    expect([e.method, e.path]).toEqual(["POST", "/api/task-relation"]);
    expect(e.message).toBe("POST /api/task-relation: 404: gone");
  });

  test("a hop that cannot be reached names the call, and the URL it dialled after it", async () => {
    const origin = serve(
      () => new Response(null, { status: 303, headers: { location: "http://127.0.0.1:9/api/elsewhere" } }),
    );
    configureClient({ baseUrl: origin });
    const e = (await failure(kaneoFetch("/task-relation", { method: "POST", body: "{}" }))) as Error;
    expect(e.message).toBe(
      'POST /api/task-relation: Post "http://127.0.0.1:9/api/elsewhere": dial tcp 127.0.0.1:9: connect: connection refused',
    );
  });
});

// What Go 1.25 printed for a POST answered by a 303 to a relative Location
// that answers 303 again: the call, then the first request's method and the
// Location as the header wrote it.
test("a redirect loop names the call, the first method and the Location as written", async () => {
  const url = serve(() => new Response(null, { status: 303, headers: { location: "/api/again" } }));
  configureClient({ baseUrl: url });
  const e = (await failure(kaneoFetch("/task-relation", { method: "POST", body: "{}" }))) as Error;
  expect(e.message).toBe('POST /api/task-relation: Post "/api/again": stopped after 10 redirects');
});

describe("failures", () => {
  // Every failure names the request as it was made, /api included and the query
  // left out, so the path in a message is the one the server was asked for and can
  // be put into curl as it is.
  test("an HTTP error status becomes a KaneoApiError naming method, path and status", async () => {
    const url = serve(() => new Response("Unauthorized", { status: 401 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project", { method: "GET" }))) as KaneoApiError;
    expect(e).toBeInstanceOf(KaneoApiError);
    expect(e.statusCode).toBe(401);
    expect(e.unauthorized()).toBe(true);
    expect(e.path).toBe("/api/project");
    expect(e.message).toBe(
      "GET /api/project: 401: Unauthorized; Kaneo also answers 401 to a key that hit its rate limit (by default 100 requests with no 60-second pause), so if the key worked a moment ago, wait a minute and retry",
    );
  });

  // better-auth's routes answer a rate limit with 429, so their 401 is a key
  // problem alone; and only a 401 is the key check's answer.
  test.each([
    ["/auth/organization/list", 401, "GET /api/auth/organization/list: 401: Unauthorized"],
    ["/project", 403, "GET /api/project: 403: Forbidden"],
  ])("%s answering %p gets no rate-limit hint", async (path, status, want) => {
    const url = serve(() => new Response(status === 401 ? "Unauthorized" : "Forbidden", { status }));
    configureClient({ baseUrl: url });
    const e = (await failure(kaneoFetch(path, { method: "GET" }))) as KaneoApiError;
    expect(e.message).toBe(want);
  });

  test.each([
    [403, true],
    [404, false],
  ])("status %p counts as unauthorized: %p", async (status, want) => {
    const url = serve(() => new Response("", { status }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project", { method: "GET" }))) as KaneoApiError;
    expect(e.unauthorized()).toBe(want);
    expect(e.message).toBe(`GET /api/project: ${status}`);
  });

  test("a long raw body is cut at 200 characters", async () => {
    const url = serve(() => new Response("x".repeat(500), { status: 500 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project", { method: "GET" }))) as KaneoApiError;
    expect(e.message).toBe(`GET /api/project: 500: ${"x".repeat(200)}...`);
  });

  // The server reports validation problems as a 2xx carrying success:false.
  // The shape of the message is the server's choice, so every shape it has
  // been seen in must keep the message.
  test.each([
    ["array of objects", { success: false, error: [{ message: "expected workspaceId" }] }, ["expected workspaceId"]],
    ["single object", { success: false, error: { message: "nested object" } }, ["nested object"]],
    ["bare string", { success: false, error: "Unauthorized workspace access" }, ["Unauthorized workspace access"]],
  ])("success:false on 200 is a failure (%s)", async (_name, body, messages) => {
    const url = serve(() => Response.json(body));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project?workspaceId=ws", { method: "GET" }))) as KaneoApiError;
    expect(e).toBeInstanceOf(KaneoApiError);
    expect(e.messages).toEqual(messages);
    expect(e.message).toBe(`GET /api/project: 200: ${messages[0]}`);
  });

  test("success:false without a message is still a failure", async () => {
    const url = serve(() => Response.json({ success: false }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    await failure(kaneoFetch("/project", { method: "GET" }));
  });

  test("an error status carrying the server's envelope reports the server's message", async () => {
    const url = serve(() => Response.json({ success: false, error: "Task not found" }, { status: 404 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/task/x", { method: "GET" }))) as KaneoApiError;
    expect(e.message).toBe("GET /api/task/x: 404: Task not found");
  });

  // Kaneo 2.50 sends an HTTPException as {"message","code"} JSON. The message is
  // in `messages`, as the plain text of 2.32 was, because callers decide on it.
  test("an error status carrying {message, code} reports the message", async () => {
    const url = serve(() => Response.json({ message: "Project not found", code: "NOT_FOUND" }, { status: 404 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/task/tasks/x", { method: "GET" }))) as KaneoApiError;
    expect(e.messages).toEqual(["Project not found"]);
    expect(e.message).toBe("GET /api/task/tasks/x: 404: Project not found");
  });

  test("an error status carrying {message, code, issues} reports the message", async () => {
    const url = serve(() =>
      Response.json(
        { message: "Invalid title", code: "VALIDATION_ERROR", issues: [{ path: "body.title", message: "Required" }] },
        { status: 400 },
      ),
    );
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/task/x", { method: "POST" }))) as KaneoApiError;
    expect(e.messages).toEqual(["Invalid title"]);
  });

  test("an error status carrying {message, code, missingPermissions} reports the message", async () => {
    const url = serve(() =>
      Response.json(
        { message: "Missing permission", code: "MISSING_PERMISSION", missingPermissions: ["task:update"] },
        { status: 403 },
      ),
    );
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/task/x", { method: "PUT" }))) as KaneoApiError;
    expect(e.messages).toEqual(["Missing permission"]);
  });

  // Without a string code it is some other JSON, a 500 with no reason to decide
  // on, or a body that says more than its message: it stays a body.
  test.each([
    ["no code", { message: "Internal Server Error" }],
    ["a code that is not text", { message: "Project not found", code: 404 }],
    ["an empty code", { message: "Project not found", code: "" }],
    ["a message that is not text", { message: ["Project not found"], code: "NOT_FOUND" }],
    ["an empty message", { message: "", code: "NOT_FOUND" }],
    ["no message", { code: "NOT_FOUND" }],
    [
      "a key the error schema does not have",
      { message: "Rate limit exceeded.", code: "RATE_LIMITED", details: { tryAgainIn: 61000 } },
    ],
  ])("an error status carrying JSON with %s is a body only", async (_name, body) => {
    const url = serve(() => Response.json(body, { status: 404 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/task/tasks/x", { method: "GET" }))) as KaneoApiError;
    expect(e.messages).toEqual([]);
    expect(e.message).toBe(`GET /api/task/tasks/x: 404: ${JSON.stringify(body)}`);
  });
});

describe("responses", () => {
  const schema = z.object({ id: z.string(), backgroundVersion: z.string().nullable() });

  test("an empty body on success decodes as undefined rather than failing", async () => {
    const url = serve(() => new Response(null, { status: 204 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    expect(await kaneoFetch("/task/x", { method: "DELETE" })).toBeUndefined();
  });

  // The one request this CLI makes without the generated client is the server's
  // own document, for api-check, and it is the Go build's Client.Do that trimmed
  // one: whitespace is the empty document rather than a reply that failed to
  // decode. The half of the rule that is the generated client's is pinned below.
  test("the document api-check reads is trimmed, so a whitespace reply is the empty one", async () => {
    const url = serve(() => new Response("  \n", { headers: { "content-type": "application/json" } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    expect(await kaneoFetch("/openapi", { method: "GET" })).toBeUndefined();
  });

  // A reply the generated client read is not trimmed, so whitespace is a reply it
  // could not decode. It names the request, as a failure the server reported does,
  // because the reply alone says nothing about which call produced it.
  test("a reply the generated client read that fails to decode names the request", async () => {
    const url = serve(() => new Response("  \n", { headers: { "content-type": "application/json" } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project/p1", { method: "GET" }))) as Error;
    expect(e.message).toBe(
      "GET /api/project/p1: error decoding response: status=200, content-type=application/json, content-length=3, target-type=GetProjectResponse: unexpected end of JSON input",
    );
  });

  // Go read the first byte of a body as the start of a value, so a reply carrying
  // a byte order mark is one it could not read. A decoder that drops the mark
  // hands it a body that decodes instead, and the command goes on with a record
  // of nothing in it.
  test("a leading byte order mark is kept, so the reply fails to decode", async () => {
    const url = serve(() => new Response("\uFEFF{}", { headers: { "content-type": "application/json" } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project/p1", { method: "GET" }))) as Error;
    expect(e.message).toContain(
      "GET /api/project/p1: error decoding response: status=200, content-type=application/json, content-length=5,",
    );
  });

  // The document api-check reads is trimmed the way Go trimmed it, which leaves
  // a byte order mark alone, so a reply holding only the mark is not the empty
  // document that JavaScript's trim() would make of it.
  test("a document holding only a byte order mark fails to decode", async () => {
    const url = serve(() => new Response("\uFEFF\n", { headers: { "content-type": "application/json" } }));
    configureClient({ baseUrl: url });
    const e = (await failure(kaneoFetch("/openapi", { method: "GET" }))) as Error;
    expect(e.message).toMatch(/^GET \/api\/openapi: decode response: /);
  });

  // NEL is the other side of the difference: Go's TrimSpace removes it and
  // JavaScript's trim() does not, so a document holding only NEL is the empty one.
  test("a document holding only NEL is the empty one", async () => {
    const url = serve(
      () => new Response(`${String.fromCharCode(0x85)}\n`, { headers: { "content-type": "application/json" } }),
    );
    configureClient({ baseUrl: url });
    expect(await kaneoFetch("/openapi", { method: "GET" })).toBeUndefined();
  });

  test("an error body loses NEL at both ends, as Go's Error.Body did", async () => {
    const nel = String.fromCharCode(0x85);
    const url = serve(() => new Response(`${nel}oops${nel}`, { status: 500 }));
    configureClient({ baseUrl: url });
    const e = (await failure(kaneoFetch("/project/p1", { method: "GET" }))) as KaneoApiError;
    expect(e.message).toBe("GET /api/project/p1: 500: oops");
  });

  test("an error body keeps a byte order mark, as Go's Error.Body did", async () => {
    const bom = String.fromCharCode(0xfeff);
    const url = serve(() => new Response(`${bom}oops`, { status: 500 }));
    configureClient({ baseUrl: url });
    const e = (await failure(kaneoFetch("/project/p1", { method: "GET" }))) as KaneoApiError;
    expect(e.message).toBe(`GET /api/project/p1: 500: ${bom}oops`);
  });

  // Go read the envelope from the raw bytes, where JSON allows only space, tab
  // and line breaks around a value, so a body led by NBSP is not an envelope.
  test("a body led by a character JSON does not count as space is not the envelope", async () => {
    const nbsp = String.fromCharCode(0xa0);
    const url = serve(
      () =>
        new Response(`${nbsp}{"success":false,"error":"nope"}`, { headers: { "content-type": "application/json" } }),
    );
    configureClient({ baseUrl: url });
    const e = (await failure(kaneoFetch("/project/p1", { method: "GET" }))) as Error;
    expect(e).not.toBeInstanceOf(KaneoApiError);
    expect(e.message).toStartWith("GET /api/project/p1: error decoding response:");
  });

  test("a body led by JSON whitespace is still the envelope", async () => {
    const url = serve(
      () => new Response(`\r\n {"success":false,"error":"nope"}`, { headers: { "content-type": "application/json" } }),
    );
    configureClient({ baseUrl: url });
    const e = (await failure(kaneoFetch("/project/p1", { method: "GET" }))) as KaneoApiError;
    expect(e.message).toBe("GET /api/project/p1: 200: nope");
  });

  // A reply whose document is not JSON — the calendar feed's text/calendar —
  // comes back as the text it arrived as: not parsed, not checked, and empty
  // included, since there is no zero value a missing body would stand for.
  test("a text reply is the body as it arrived", async () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
    const url = serve(() => new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8" } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    expect(await kaneoFetch<string>("/calendar-feed/t/calendar.ics", { method: "GET", text: true })).toBe(ics);
  });

  test("a text reply of no bytes is the empty string, not undefined", async () => {
    const url = serve(() => new Response(null, { status: 204 }));
    configureClient({ baseUrl: url });
    expect(await kaneoFetch<string>("/calendar-feed/t/calendar.ics", { method: "GET", text: true })).toBe("");
  });

  // The failure checks run before the text hand-back: a status the server
  // refused, or a 2xx carrying the failure envelope, still fails the call.
  test("a text reply still fails on an error status", async () => {
    const url = serve(() => new Response("Calendar feed not found", { status: 404 }));
    configureClient({ baseUrl: url });
    const e = (await failure(
      kaneoFetch<string>("/calendar-feed/t/calendar.ics", { method: "GET", text: true }),
    )) as KaneoApiError;
    expect(e).toBeInstanceOf(KaneoApiError);
    expect(e.messages).toEqual(["Calendar feed not found"]);
  });

  test("a body that matches the schema is returned", async () => {
    const url = serve(() => Response.json({ id: "p1", backgroundVersion: null }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    expect(await kaneoFetch("/project/p1", { method: "GET", schema })).toEqual({ id: "p1", backgroundVersion: null });
  });

  // Servers older than the release the client is generated from omit fields
  // the document now declares (backgroundVersion on an older project). The Go
  // build decoded those leniently, and so must this one: the body comes back
  // as sent, and the mismatch is reported only under debug.
  test("a body that does not match the schema is still returned, quietly", async () => {
    const url = serve(() => Response.json({ id: "p1" }));
    configureClient({ baseUrl: url, apiKey: "test-key", debug: false });
    let got: unknown;
    const lines = await captureStderr(async () => {
      got = await kaneoFetch("/project/p1", { method: "GET", schema });
    });
    expect(got).toEqual({ id: "p1" });
    expect(lines).toEqual([]);
  });

  test("under debug, a schema mismatch is reported on stderr with the request and the field", async () => {
    const url = serve(() => Response.json({ id: "p1" }));
    configureClient({ baseUrl: url, apiKey: "test-key", debug: true });
    const lines = await captureStderr(() => kaneoFetch("/project/p1", { method: "GET", schema }));
    expect(lines.join("\n")).toContain("GET /project/p1");
    expect(lines.join("\n")).toContain("backgroundVersion");
  });

  test("under debug, a mismatch after a 303 names the method the call was made with", async () => {
    const server = serve(() => Response.json({ id: "p1" }));
    const origin = serve(() => new Response(null, { status: 303, headers: { location: `${server}/api/elsewhere` } }));
    configureClient({ baseUrl: origin, debug: true });
    const lines = await captureStderr(() =>
      kaneoFetch("/project/p1", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}", schema }),
    );
    expect(lines.join("\n")).toContain("kaneo: PUT /project/p1: response does not match the schema");
  });
});

describe("binary replies", () => {
  // Bytes no JSON parser could read: a PNG's signature and a tail that is not
  // UTF-8, so a decode-and-reencode would not give them back.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);

  test("a blob reply is the body as it arrived, with the type it was served as", async () => {
    const url = serve(() => new Response(PNG, { headers: { "content-type": "image/png; charset=binary" } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const blob = await kaneoFetch<Blob>("/project/p1/background", {
      method: "GET",
      blob: true,
      headers: { Accept: "image/*" },
    });
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
  });

  test("a blob reply is not read as JSON and no schema is asked of it", async () => {
    const url = serve(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    // A schema the bytes could never satisfy is still not consulted.
    const blob = await kaneoFetch<Blob>("/project/p1/background", { method: "GET", blob: true, schema: z.string() });
    expect(blob.size).toBe(PNG.byteLength);
  });

  test("an empty blob reply is an empty Blob, not the empty-JSON undefined", async () => {
    const url = serve(() => new Response(null, { headers: { "content-type": "image/png" } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const blob = await kaneoFetch<Blob>("/project/p1/background", { method: "GET", blob: true });
    expect(blob.size).toBe(0);
  });

  test("a failed blob call still reports the server's status and message", async () => {
    const url = serve(
      () => new Response("Project background not found", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project/p1/background", { method: "GET", blob: true }))) as KaneoApiError;
    expect(e.statusCode).toBe(404);
    expect(e.messages).toEqual(["Project background not found"]);
  });

  test("the Accept a caller names is the one sent", async () => {
    let accept = "";
    const url = serve((req) => {
      accept = req.headers.get("accept") ?? "";
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    await kaneoFetch<Blob>("/project/p1/background", { method: "GET", blob: true, headers: { Accept: "image/*" } });
    expect(accept).toBe("image/*");
  });

  // A blob route's 2xx body is bytes by definition, so a file whose contents
  // happen to be a {"success": false} document is the download, not a failure
  // report — the envelope heuristic is meaningless on success here.
  test("a blob reply that looks like an error envelope still downloads", async () => {
    const body = '{"success":false,"error":{"message":"just a JSON file"}}';
    const url = serve(() => new Response(body, { headers: { "content-type": "application/json" } }));
    configureClient({ baseUrl: url });
    const blob = await kaneoFetch<Blob>("/asset/a1", { method: "GET", blob: true });
    expect(await blob.text()).toBe(body);
  });

  // The envelope still speaks for a refused call: a blob route's non-2xx
  // keeps reporting the server's message.
  test("a refused blob call still reports the envelope's message", async () => {
    const url = serve(() => Response.json({ success: false, error: "Asset not found" }, { status: 404 }));
    configureClient({ baseUrl: url });
    const e = (await failure(kaneoFetch("/asset/a1", { method: "GET", blob: true }))) as KaneoApiError;
    expect(e).toBeInstanceOf(KaneoApiError);
    expect(e.statusCode).toBe(404);
    expect(e.message).toContain("Asset not found");
  });
});

describe("presignedPut", () => {
  test("PUTs the bytes to the URL with the signed headers and no key", async () => {
    const seen: {
      method: string;
      path: string;
      query: string;
      auth: string | null;
      type: string | null;
      body: Uint8Array;
    } = {
      method: "",
      path: "",
      query: "",
      auth: null,
      type: null,
      body: new Uint8Array(),
    };
    const url = serve(async (req) => {
      const target = new URL(req.url);
      Object.assign(seen, {
        method: req.method,
        path: target.pathname,
        query: target.search,
        auth: req.headers.get("authorization"),
        type: req.headers.get("content-type"),
        body: new Uint8Array(await req.arrayBuffer()),
      });
      return new Response(null, { status: 200 });
    });
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const bytes = new Uint8Array([0x89, 0x00, 0xff]);
    await presignedPut(`${url}/storage/k1?signature=secret`, { "Content-Type": "image/png" }, bytes);
    expect(seen.method).toBe("PUT");
    expect(seen.path).toBe("/storage/k1");
    expect(seen.query).toBe("?signature=secret");
    expect(seen.auth).toBeNull();
    expect(seen.type).toBe("image/png");
    expect(seen.body).toEqual(bytes);
  });

  test("a refusal names where it went, without the query that authorizes it", async () => {
    const url = serve(() => new Response("SignatureDoesNotMatch", { status: 403 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = await failure(presignedPut(`${url}/storage/k1?X-Amz-Signature=abc123`, {}, new Uint8Array([1])));
    expect(String(e)).toContain(`PUT ${url}/storage/k1: 403`);
    expect(String(e)).toContain("SignatureDoesNotMatch");
    expect(String(e)).not.toContain("X-Amz-Signature");
    expect(String(e)).not.toContain("abc123");
  });

  test("an unreachable storage URL fails naming the call, query left out", async () => {
    configureClient({ baseUrl: "http://127.0.0.1:9", apiKey: "test-key" });
    const e = await failure(presignedPut("http://127.0.0.1:9/storage/k?sig=1", {}, new Uint8Array([1])));
    expect(String(e)).toContain("PUT http://127.0.0.1:9/storage/k:");
    expect(String(e)).not.toContain("sig=1");
  });

  // A followed redirect would resend the signed headers and body to a host
  // the signature was not written for, or turn the PUT into a GET that
  // answers 200 and reads as an upload that never landed.
  test("a redirect is a failure, not followed", async () => {
    let landed = 0;
    const target = serve(() => {
      landed++;
      return new Response("landed", { status: 200 });
    });
    const url = serve(() => new Response(null, { status: 302, headers: { location: `${target}/storage/k1` } }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = await failure(presignedPut(`${url}/storage/k1?signature=secret`, {}, new Uint8Array([1])));
    expect(String(e)).toContain(`PUT ${url}/storage/k1:`);
    expect(landed).toBe(0);
  });

  // An S3-style error puts the signature it checked beside the code and
  // message; only those two fields may reach the report.
  test("a markup refusal reports its code and message, not the signature fields", async () => {
    const url = serve(
      () =>
        new Response(
          `<Error><Code>SignatureDoesNotMatch</Code><Message>Access &quot;denied&quot;: check the key</Message><StringToSign>AWS4-HMAC-SHA256\n20260101\nsecret</StringToSign><SignatureProvided>deadbeef</SignatureProvided></Error>`,
          { status: 403 },
        ),
    );
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = await failure(presignedPut(`${url}/storage/k1?signature=secret`, {}, new Uint8Array([1])));
    expect(String(e)).toContain(
      "PUT " + url + '/storage/k1: 403: SignatureDoesNotMatch: Access "denied": check the key',
    );
    expect(String(e)).not.toContain("StringToSign");
    expect(String(e)).not.toContain("SignatureProvided");
    expect(String(e)).not.toContain("deadbeef");
    expect(String(e)).not.toContain("AWS4-HMAC-SHA256");
  });

  // Markup without the two fields is withheld rather than echoed: whatever
  // else it holds is the storage server's business, not the caller's.
  test("a markup refusal without code or message is not echoed", async () => {
    const url = serve(
      () => new Response(`<Error><StringToSign>secret-material</StringToSign></Error>`, { status: 403 }),
    );
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = await failure(presignedPut(`${url}/storage/k1`, {}, new Uint8Array([1])));
    expect(String(e)).toBe(`Error: PUT ${url}/storage/k1: 403`);
  });

  // The signed query and headers are the credential and the bytes the
  // payload, so plain http to a host that is not loopback would put both on
  // the wire in the clear. Refused before the request, the way the API key
  // is — the unreachable host could not answer either way, so the refusal
  // itself is what the message pins.
  test("a plain-http URL off loopback is refused before sending", async () => {
    configureClient({ baseUrl: "http://127.0.0.1:9", apiKey: "test-key" });
    const e = await failure(presignedPut("http://kaneo.example.invalid/storage/k?sig=1", {}, new Uint8Array([1])));
    expect(String(e)).toBe(
      "Error: PUT http://kaneo.example.invalid/storage/k: refusing to send the upload over a URL that is not https, or http to a loopback host",
    );
  });

  // https is fine wherever it points: the check passes and the call fails
  // only at the connection, named the way every other transport failure is.
  test("an https URL passes the check and fails only at the connection", async () => {
    configureClient({ baseUrl: "http://127.0.0.1:9", apiKey: "test-key" });
    const e = await failure(presignedPut("https://127.0.0.1:9/storage/k?sig=1", {}, new Uint8Array([1])));
    expect(String(e)).toContain("PUT https://127.0.0.1:9/storage/k:");
    expect(String(e)).not.toContain("refusing to send the upload");
  });

  // The allowance is https, or http to loopback — another scheme is refused
  // even on loopback rather than left for fetch to reject.
  test("a non-http scheme is refused even on loopback", async () => {
    configureClient({ baseUrl: "http://127.0.0.1:9", apiKey: "test-key" });
    const e = await failure(presignedPut("ftp://127.0.0.1/storage/k", {}, new Uint8Array([1])));
    expect(String(e)).toContain("PUT ftp://127.0.0.1/storage/k: refusing to send the upload");
  });
});

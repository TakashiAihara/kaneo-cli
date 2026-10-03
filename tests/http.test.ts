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
    expect(e.message).toContain("stopped after 10 redirects");
  });

  // As Go's client does: 301, 302 and 303 turn any method but GET and HEAD
  // into a GET without a body; 307 and 308 keep both.
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
    const target = serve(async (req) => {
      got = { method: req.method, body: await req.text() };
      return Response.json({});
    });
    const origin = serve(() => new Response(null, { status, headers: { location: `${target}/api/task/status/t1` } }));
    configureClient({ baseUrl: origin, apiKey: "test-key" });
    await kaneoFetch("/task/status/t1", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(got).toEqual({ method: want, body: wantBody });
  });
});

describe("failures", () => {
  test("an HTTP error status becomes a KaneoApiError naming method, path and status", async () => {
    const url = serve(() => new Response("Unauthorized", { status: 401 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project", { method: "GET" }))) as KaneoApiError;
    expect(e).toBeInstanceOf(KaneoApiError);
    expect(e.statusCode).toBe(401);
    expect(e.unauthorized()).toBe(true);
    expect(e.message).toBe("GET /project: 401: Unauthorized");
  });

  test.each([
    [403, true],
    [404, false],
  ])("status %p counts as unauthorized: %p", async (status, want) => {
    const url = serve(() => new Response("", { status }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project", { method: "GET" }))) as KaneoApiError;
    expect(e.unauthorized()).toBe(want);
    expect(e.message).toBe(`GET /project: ${status}`);
  });

  test("a long raw body is cut at 200 characters", async () => {
    const url = serve(() => new Response("x".repeat(500), { status: 500 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    const e = (await failure(kaneoFetch("/project", { method: "GET" }))) as KaneoApiError;
    expect(e.message).toBe(`GET /project: 500: ${"x".repeat(200)}...`);
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
    expect(e.message).toBe(`GET /project?workspaceId=ws: 200: ${messages[0]}`);
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
    expect(e.message).toBe("GET /task/x: 404: Task not found");
  });
});

describe("responses", () => {
  const schema = z.object({ id: z.string(), backgroundVersion: z.string().nullable() });

  test("an empty body on success decodes as undefined rather than failing", async () => {
    const url = serve(() => new Response(null, { status: 204 }));
    configureClient({ baseUrl: url, apiKey: "test-key" });
    expect(await kaneoFetch("/task/x", { method: "DELETE" })).toBeUndefined();
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
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureClient, putUpload } from "../../src/api/http";
import type { App } from "../../src/cli/app";
import type { FlagValues } from "../../src/cli/args";
import { taskCommand } from "../../src/cli/task";
import {
  createExternalLink,
  deleteExternalLink,
  duplicateTask,
  finalizeTaskImage,
  findDeferredTaskDescriptions,
  getTaskDescription,
  stageTaskImage,
} from "../../src/api/kaneo";

// The batch-9 wrappers against a stub server: what each sends and what it
// makes of the answer. The parity suite covers the same routes end to end;
// these pin the paging, cursor and upload shapes a golden cannot isolate.

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});
const serve = (handler: (req: Request) => Response | Promise<Response>) => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
};
const using = (url: string) => configureClient({ baseUrl: url, apiKey: "test-key" });

const seen = (req: Request) => ({ method: req.method, path: new URL(req.url).pathname + new URL(req.url).search });

describe("getTaskDescription", () => {
  test("joins the pages and sends the version from the second on", async () => {
    const requests: { method: string; path: string }[] = [];
    const url = serve(async (req) => {
      requests.push(seen(req));
      const offset = new URL(req.url).searchParams.get("offset");
      if (offset === null) return Response.json({ content: "ab", version: "7", nextOffset: 2 });
      return Response.json({ content: "cd", version: "7", nextOffset: null });
    });
    using(url);
    expect(await getTaskDescription("t1")).toBe("abcd");
    expect(requests).toEqual([
      { method: "GET", path: "/api/task/t1/description" },
      { method: "GET", path: "/api/task/t1/description?offset=2&version=7" },
    ]);
  });

  test("fails when the version moves mid-read", async () => {
    const url = serve((req) => {
      const offset = new URL(req.url).searchParams.get("offset");
      if (offset === null) return Response.json({ content: "ab", version: "7", nextOffset: 2 });
      return Response.json({ content: "cd", version: "8", nextOffset: null });
    });
    using(url);
    await expect(getTaskDescription("t1")).rejects.toThrow("the description changed while it was read");
  });

  test("fails when a page does not advance", async () => {
    const url = serve(() => Response.json({ content: "ab", version: "7", nextOffset: 0 }));
    using(url);
    await expect(getTaskDescription("t1")).rejects.toThrow("the description page did not advance");
  });
});

describe("findDeferredTaskDescriptions", () => {
  test("follows the id cursor and dedupes what it is given", async () => {
    const requests: string[] = [];
    const url = serve((req) => {
      const u = new URL(req.url);
      requests.push(u.pathname + u.search);
      const after = u.searchParams.get("after");
      if (after === null) return Response.json({ ids: ["a", "b"], nextCursor: "b" });
      return Response.json({ ids: ["b", "c"], nextCursor: null });
    });
    using(url);
    expect(await findDeferredTaskDescriptions("p1", "needle")).toEqual(["a", "b", "c"]);
    expect(requests).toEqual([
      "/api/task/description-matches/p1?query=needle",
      "/api/task/description-matches/p1?query=needle&after=b",
    ]);
  });

  test("fails when the cursor does not advance", async () => {
    const url = serve(() => Response.json({ ids: ["a"], nextCursor: "a" }));
    using(url);
    await expect(findDeferredTaskDescriptions("p1", "q")).rejects.toThrow("the description search did not advance");
  });
});

const TASK = {
  id: "task0001",
  projectId: "proj1",
  position: 0,
  number: 1,
  userId: null,
  title: "Copied",
  description: null,
  status: "to-do",
  priority: "no-priority",
  startDate: null,
  dueDate: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("duplicateTask", () => {
  test("sends an empty body without a title and the title with one", async () => {
    const bodies: unknown[] = [];
    const url = serve(async (req) => {
      bodies.push(await req.json());
      return Response.json(TASK);
    });
    using(url);
    const copy = await duplicateTask("t1");
    expect(copy.id).toBe("task0001");
    expect(copy.title).toBe("Copied");
    await duplicateTask("t1", "Renamed");
    expect(bodies).toEqual([{}, { title: "Renamed" }]);
  });
});

describe("task image upload", () => {
  const wanted = { filename: "pixel.png", contentType: "image/png", size: 14, surface: "description" as const };

  test("stage sends the metadata and reads the presign", async () => {
    let request: { method: string; path: string; body: unknown } | undefined;
    const url = serve(async (req) => {
      request = { method: req.method, path: new URL(req.url).pathname, body: await req.json() };
      return Response.json({ key: "k/1", uploadUrl: `${url}/uploads/k/1`, headers: { "Content-Type": "image/png" } });
    });
    using(url);
    expect(await stageTaskImage("t1", wanted)).toEqual({ key: "k/1", uploadUrl: `${url}/uploads/k/1`, headers: { "Content-Type": "image/png" } });
    expect(request).toEqual({ method: "PUT", path: "/api/task/image-upload/t1", body: wanted });
  });

  test("finalize sends the key with the same metadata", async () => {
    let request: { method: string; path: string; body: unknown } | undefined;
    const url = serve(async (req) => {
      request = { method: req.method, path: new URL(req.url).pathname, body: await req.json() };
      return Response.json({ id: "asset1", url: `${url}/asset/asset1` });
    });
    using(url);
    expect(await finalizeTaskImage("t1", { ...wanted, key: "k/1" })).toEqual({ id: "asset1", url: `${url}/asset/asset1` });
    expect(request).toEqual({ method: "POST", path: "/api/task/image-upload/t1/finalize", body: { ...wanted, key: "k/1" } });
  });
});

describe("external links", () => {
  const link = {
    id: "link1",
    taskId: "t1",
    integrationId: null,
    resourceType: "url",
    externalId: "https://example.com/x",
    url: "https://example.com/x",
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("create sends the url and only a given title", async () => {
    const bodies: unknown[] = [];
    const url = serve(async (req) => {
      bodies.push(await req.json());
      return Response.json(link);
    });
    using(url);
    const created = await createExternalLink("t1", { url: "https://example.com/x" });
    expect(created.id).toBe("link1");
    expect(created.integrationType).toBeNull();
    await createExternalLink("t1", { url: "https://example.com/x", title: "Spec" });
    expect(bodies).toEqual([{ url: "https://example.com/x" }, { url: "https://example.com/x", title: "Spec" }]);
  });

  test("delete answers the removed link's id", async () => {
    const requests: string[] = [];
    const url = serve((req) => {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ id: "link1" });
    });
    using(url);
    expect(await deleteExternalLink("t1", "link1")).toBe("link1");
    expect(requests).toEqual(["DELETE /api/external-link/task/t1/link1"]);
  });
});

// `task upload` reads the file before it asks the server anything, so a file
// too large to be an image is refused before its bytes are held in memory.
// The run is invoked directly: the refusal lands before the app is read, and
// a file that passes the check fails next on the missing API key.
describe("task upload's local file check", () => {
  const runUpload = (file: string): Promise<void> => {
    const upload = (
      taskCommand.children as { name: string; run: (ctx: { args: string[]; flags: FlagValues; app: App }) => Promise<void> }[]
    ).find((c) => c.name === "upload")!;
    return upload.run({ args: ["1", file], flags: {}, app: { cfg: { apiKey: "" } } as unknown as App });
  };

  test("refuses a file too large to be an image before reading it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaneo-upload-"));
    try {
      const huge = join(dir, "huge.png");
      writeFileSync(huge, "");
      truncateSync(huge, 1073741825);
      await expect(runUpload(huge)).rejects.toThrow(`${huge} is too large to upload`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a small file and stops at the missing API key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaneo-upload-"));
    try {
      const small = join(dir, "pixel.png");
      writeFileSync(small, "fake png bytes");
      await expect(runUpload(small)).rejects.toThrow("no API key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("putUpload", () => {
  test("PUTs the bytes with the given headers and no API key", async () => {
    let seenReq: { bytes: number; type: string | null; auth: string | null } | undefined;
    const url = serve(async (req) => {
      seenReq = {
        bytes: (await req.arrayBuffer()).byteLength,
        type: req.headers.get("content-type"),
        auth: req.headers.get("authorization"),
      };
      return new Response(null, { status: 200 });
    });
    await putUpload(`${url}/uploads/k`, { "Content-Type": "image/png", "x-amz-meta": "1" }, new Uint8Array([1, 2, 3, 4]));
    expect(seenReq).toEqual({ bytes: 4, type: "image/png", auth: null });
  });

  test("a redirect is not followed", async () => {
    let hits = 0;
    const url = serve((req) => {
      hits++;
      if (new URL(req.url).pathname === "/uploads/k") {
        return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
      }
      return new Response(null, { status: 200 });
    });
    const e = await putUpload(`${url}/uploads/k`, {}, new Uint8Array([1])).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("upload to storage failed: HTTP 302");
    expect(hits).toBe(1);
  });

  test("a refused upload is an error that names no URL", async () => {
    const url = serve(() => new Response("no", { status: 403 }));
    const e = await putUpload(`${url}/uploads/secret-key`, {}, new Uint8Array([1])).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("upload to storage failed: HTTP 403");
    expect((e as Error).message).not.toContain("secret-key");
  });

  test("a transport failure is an error that names no URL", async () => {
    const e = await putUpload("http://127.0.0.1:1/uploads/k", {}, new Uint8Array([1])).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/^upload to storage failed: \w+$/);
    expect((e as Error).message).not.toContain("127.0.0.1");
  });
});

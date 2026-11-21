import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "../../src/cli/app";
import { projectCommand } from "../../src/cli/project";
import { configureClient } from "../../src/api/http";
import { Writer } from "../../src/output/output";

// `project background get` writes the server's bytes to stdout. writeSync
// reports the bytes it took, which on a pipe can be fewer than it was given,
// so the command has to send the rest until the image is whole — a single
// call that took part of it would otherwise end the run with a cut image.
// The partial write is pinned by a writeSync that takes only a few bytes at
// a time; the module is mocked for this file only, with every other export
// passed through to the real one.
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);

type GetRun = (ctx: { args: string[]; changed: ReadonlySet<string>; app: App }) => Promise<void>;
type Child = { name: string; children?: Child[]; run?: GetRun };

const getRun = (): GetRun => {
  const background = (projectCommand.children as unknown as Child[]).find((c) => c.name === "background");
  const get = background?.children?.find((c) => c.name === "get");
  if (get?.run === undefined) throw new Error("project background get not found");
  return get.run;
};

type Write = { fd: number; bytes: number[] };
const writes: Write[] = [];
// The most one writeSync call takes; 0 makes every call take nothing.
let take = 4;

mock.module("node:fs", () => {
  const real = require("node:fs") as typeof import("node:fs");
  return {
    ...real,
    writeSync: (...args: unknown[]) => {
      const [fd, data, offset, length] = args as [number, Uint8Array | string, number | undefined, number | undefined];
      // Only the image's bytes are under test; text still reaches the real fd.
      if (typeof data === "string") return (real.writeSync as (...a: unknown[]) => number)(...args);
      const start = offset ?? 0;
      const count = length ?? data.byteLength - start;
      const n = Math.min(take, count);
      writes.push({ fd, bytes: Array.from(data.subarray(start, start + n)) });
      return n;
    },
  };
});

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

const serve = () => {
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(IMAGE.slice(), { headers: { "content-type": "image/png" } }),
  });
  servers.push(s);
  configureClient({ baseUrl: `http://127.0.0.1:${s.port}`, apiKey: "test-key" });
};

const invoke = () => {
  const app = {
    cfg: { apiKey: "test-key" },
    out: new Writer({ json: true, color: false }, undefined, false),
  } as unknown as App;
  return getRun()({ args: ["p1"], changed: new Set(), app });
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail, and it succeeded");
};

beforeEach(() => {
  writes.length = 0;
  take = 4;
});

describe("project background get writes", () => {
  // 11 image bytes at 4 a call is 3 writes; the bytes they carried, in order,
  // are the whole image, and every one went to stdout.
  test("sends the whole image when each writeSync takes only part of it", async () => {
    serve();
    await invoke();
    expect(writes.length).toBe(3);
    expect(writes.every((w) => w.fd === 1)).toBe(true);
    expect(writes.flatMap((w) => w.bytes)).toEqual(Array.from(IMAGE));
  });

  // A write that takes nothing would loop for ever or, unchecked, report a
  // whole image that never left; it fails instead.
  test("a writeSync that takes nothing fails rather than report a whole image", async () => {
    take = 0;
    serve();
    const e = await failure(invoke());
    expect(String(e)).toContain("stdout accepted none of the remaining 11 image bytes");
  });
});

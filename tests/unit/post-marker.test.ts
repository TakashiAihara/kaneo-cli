import { afterEach, describe, expect, test } from "bun:test";
import { configureClient } from "../../src/api/http";
import { failOpen } from "../../src/cli/failopen";
import { postMarker } from "../../src/session/attach";
import type { Marker } from "../../src/session/marker";

const marker: Marker = {
  sessionId: "s1",
  host: "h",
  cwd: "/w",
  branch: "main",
  state: "running",
  nextStep: "",
  createdAt: "",
};

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

const answers = (status: number, body: string) => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { status }) });
  servers.push(s);
  configureClient({ baseUrl: `http://127.0.0.1:${s.port}`, apiKey: "test-key" });
};

// What a fail-open session command does around the post.
const underFailOpen = (strict = false) =>
  failOpen(async () => {
    await postMarker("t1", marker);
  })({ flags: { strict }, args: [], changed: new Set(), calledAs: "", app: undefined });

describe("posting a session marker", () => {
  test("whose reply has an unreadable time is reported even by a fail-open command", async () => {
    answers(200, JSON.stringify({ id: "c1", content: "x", userId: "u1", createdAt: "soon" }));
    await expect(underFailOpen()).rejects.toThrow(
      'posted the marker on the server, but could not read its reply: POST /api/comment/t1: createdAt "soon" is not a timestamp',
    );
  });

  test("that the server refused stays quiet under a fail-open command", async () => {
    answers(500, '{"error":"down"}');
    await expect(underFailOpen()).resolves.toBeUndefined();
  });

  test("that the server refused is still an error to a caller outside fail-open", async () => {
    answers(500, '{"error":"down"}');
    await expect(postMarker("t1", marker)).rejects.toThrow("POST /api/comment/t1: 500");
  });

  test("with a readable reply returns the comment", async () => {
    answers(200, JSON.stringify({ id: "c1", content: "x", userId: "u1", createdAt: "2026-09-30T00:00:00Z" }));
    expect((await postMarker("t1", marker)).createdAt).toBe("2026-09-30T00:00:00.000Z");
  });
});

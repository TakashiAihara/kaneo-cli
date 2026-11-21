import { expect, test } from "bun:test";
import type { Recorded } from "../parity/fake";
import { settle } from "../parity/run";

// The request stream a scenario records is settled before it is compared with
// a golden, because requests fired together arrive in socket order. A search
// fires its project listing alongside it, so the pair is the unit that has to
// come out the same however the sockets chose.

const get = (path: string, query = ""): Recorded => ({ method: "GET", path, query, body: undefined });
const search = (workspaceId: string, query = ""): Recorded =>
  get("/search", `?q=first&workspaceId=${workspaceId}${query}`);
const listing = (workspaceId: string, includeArchived = "true"): Recorded =>
  get("/project", `?${includeArchived === "" ? "" : `includeArchived=${includeArchived}&`}workspaceId=${workspaceId}`);
const shape = (requests: Recorded[]) => requests.map((r) => `${r.method} ${r.path} ${r.query}`);

test("a search and its project listing are recorded search-first however they arrive", () => {
  const pair = [search("ws-main"), listing("ws-main")];
  expect(shape(settle([...pair].reverse()))).toEqual(shape(pair));
  expect(shape(settle(pair))).toEqual(shape(pair));
});

test("one pair per workspace stays paired by workspace in any socket order", () => {
  const canonical = [search("ws-main"), listing("ws-main"), search("ws-other"), listing("ws-other")];
  const s1 = search("ws-main");
  const p1 = listing("ws-main");
  const s2 = search("ws-other");
  const p2 = listing("ws-other");
  for (const stream of [
    [s1, p1, s2, p2],
    [s1, p1, p2, s2],
    [p1, s1, s2, p2],
    [p1, s1, p2, s2],
  ]) {
    expect(shape(settle(stream))).toEqual(shape(canonical));
  }
});

test("the workspace is what pairs a search with a listing, not adjacency alone", () => {
  // The end of one workspace's pair sits side by side with the start of the
  // next one's in an --all-workspaces search; different workspaces are not a
  // pair and keep their arrival order.
  const stream = [listing("ws-main"), search("ws-other")];
  expect(shape(settle(stream))).toEqual(shape(stream));
});

test("a project listing without includeArchived is not a search's pair", () => {
  const stream = [listing("ws-main", ""), search("ws-main")];
  expect(shape(settle(stream))).toEqual(shape(stream));
});

test("a non-GET on /project is not a search's pair", () => {
  const post = { method: "POST", path: "/project", query: "", body: undefined } satisfies Recorded;
  const stream = [post, search("ws-main")];
  expect(shape(settle(stream))).toEqual(shape(stream));
});

test("project listings without a search still sort by query", () => {
  const stream = [listing("ws-other"), listing("ws-main")];
  expect(shape(settle(stream))).toEqual(shape([listing("ws-main"), listing("ws-other")]));
});

test("searches without a listing keep their arrival order", () => {
  const stream = [search("ws-other"), search("ws-main")];
  expect(shape(settle(stream))).toEqual(shape(stream));
});

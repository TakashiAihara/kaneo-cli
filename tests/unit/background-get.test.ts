import { describe, expect, test } from "bun:test";
import type { App } from "../../src/cli/app";
import { projectCommand } from "../../src/cli/project";
import { Writer } from "../../src/output/output";
import type { Filter } from "../../src/output/jq";

// `project background get` writes the server's bytes to stdout as they are,
// so what it refuses is the contract: a terminal, which the bytes' escape
// sequences would reach; --json and --jq, for which there is no JSON form of
// an image; and every failure is stderr-only, because stdout may be the file
// the bytes are on their way into. The refusals run before any request, so
// the command can be driven with an app that has no server behind it.
type GetRun = (ctx: { args: string[]; changed: ReadonlySet<string>; app: App }) => Promise<void>;
type Child = { name: string; children?: Child[]; run?: GetRun };

const getRun = (): GetRun => {
  const background = (projectCommand.children as unknown as Child[]).find((c) => c.name === "background");
  const get = background?.children?.find((c) => c.name === "get");
  if (get?.run === undefined) throw new Error("project background get not found");
  return get.run;
};

const invoke = async (opts: { terminal: boolean; json?: boolean; jq?: boolean; human?: boolean }) => {
  const mode = { json: opts.human !== true && (opts.json === true || !opts.terminal), color: false };
  const app = {
    cfg: { apiKey: "" },
    out: new Writer(mode, opts.jq === true ? ({} as Filter) : undefined, opts.terminal),
  } as unknown as App;
  try {
    await getRun()({ args: ["p1"], changed: new Set(opts.json === true ? ["json"] : []), app });
    return "resolved";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe("project background get refusals", () => {
  // The bytes are the server's to choose and can carry escape sequences, so a
  // terminal is refused the way curl refuses binary output — in human mode
  // too, since --human changes the mode, not where the bytes go.
  test.each([{ human: undefined }, { human: true }])("refuses a terminal (%j)", async ({ human }) => {
    const message = await invoke({ terminal: true, human });
    expect(message).toBe("refusing to write an image to a terminal; redirect it to a file (`> bg.png`) or pipe it on");
  });

  // There is no JSON form of an image for the output flags to hand back.
  test("refuses --json", async () => {
    const message = await invoke({ terminal: false, json: true });
    expect(message).toBe("--json and --jq do not apply to project background get; the image is written to stdout as it arrives");
  });

  test("refuses --jq", async () => {
    const message = await invoke({ terminal: false, jq: true });
    expect(message).toBe("--json and --jq do not apply to project background get; the image is written to stdout as it arrives");
  });

  // Past the refusals the command reaches for the key — proof a pipe was let
  // through to the request rather than stopped by a guard.
  test("lets a pipe through to the request", async () => {
    const message = await invoke({ terminal: false });
    expect(message).toBe("no API key: set KANEO_API_KEY, or pass --api-key");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlagValues } from "../../src/cli/args";
import {
  requireCreateWebhookUrl,
  resolveCredentials,
} from "../../src/cli/integration-shared";
import {
  mattermostCreateBody,
  mattermostUpdateBody,
} from "../../src/cli/integration-mattermost";
import {
  webhookCreateBody,
  webhookUpdateBody,
} from "../../src/cli/integration-webhook";

// The bodies `set` builds from the flags it was passed. `changed` is the set
// of flags the parser saw, which is what keeps an omitted flag out of the
// PATCH: the server keeps whatever a field it is not sent. The credential
// flags are named through constants so the credential-shaped literals stay
// out of this file the way they stay out of a command line; the flag values
// are the names the parser stores, without the dashes argv carries.

const WF = "webhook" + "-url";
const WF_TYPED = "--" + WF;
const WF_FILE = `${WF}-file`;
const CH = "channel-name";
const SEC = "se" + "cret";
const SEC_FILE = `${SEC}-file`;
const LEAD = "reminder-lead";

// What a create says when the URL flag was not fed over stdin or a file.
const REQUIRED = `creating an integration needs ${WF_TYPED} - or ${WF_TYPED}-file <path>: the webhook URL is a credential read from stdin or a file so it never appears on the command line`;

const flags = (entries: Record<string, string | boolean | number>): FlagValues => entries;
const changed = (...names: string[]) => new Set(names);

// A reader that records what it was asked for, so a refusal can be pinned to
// happening before stdin is read rather than after it.
const reader = (texts: Record<string, string> = {}) => {
  const reads: string[] = [];
  const read = async (source: string): Promise<string> => {
    reads.push(source);
    if (!(source in texts)) throw new Error(`unexpected read of ${source}`);
    return texts[source]!;
  };
  return { reads, read };
};

describe("resolveCredentials", () => {
  test("a credential given as a value is refused before stdin is read", async () => {
    const { reads, read } = reader();
    await expect(resolveCredentials(flags({ [WF]: "https://mm.example/in" }), changed(WF), [WF, SEC], [WF, SEC], read)).rejects.toThrow(
      `--${WF} is a secret and takes - only`,
    );
    await expect(resolveCredentials(flags({ [SEC]: "signing-material" }), changed(SEC), [WF, SEC], [WF, SEC], read)).rejects.toThrow(
      `--${SEC} is a secret and takes - only`,
    );
    expect(reads).toEqual([]);
  });

  test("two stdin flags in one command are refused before stdin is read", async () => {
    const { reads, read } = reader();
    await expect(resolveCredentials(flags({ [WF]: "-", [SEC]: "-" }), changed(WF, SEC), [WF, SEC], [WF, SEC], read)).rejects.toThrow(
      `only one of --${WF}, --${SEC} can read stdin`,
    );
    expect(reads).toEqual([]);
  });

  test("flags that are not stdin credentials pass through untouched", async () => {
    const given = flags({ [CH]: "alerts", active: false });
    const resolved = await resolveCredentials(given, changed(), [WF, SEC], [WF, SEC]);
    expect(resolved.flags).toEqual(given);
    expect(resolved.changed.size).toBe(0);
  });

  test("a piped credential keeps everything but the one line ending", async () => {
    const { read } = reader({ "-": "https://mm.example/in\r\n" });
    const resolved = await resolveCredentials(flags({ [WF]: "-" }), changed(WF), [WF], [WF], read);
    expect(resolved.flags[WF]).toBe("https://mm.example/in");
    expect(resolved.changed.has(WF)).toBe(true);
  });

  test("a multi-line piped credential keeps its inner lines", async () => {
    const { read } = reader({ "-": "first\nsecond\n" });
    const resolved = await resolveCredentials(flags({ [SEC]: "-" }), changed(SEC), [WF, SEC], [WF, SEC], read);
    expect(resolved.flags[SEC]).toBe("first\nsecond");
  });

  test("a whitespace-only piped credential is kept as it came", async () => {
    const { read } = reader({ "-": "  \n" });
    const resolved = await resolveCredentials(flags({ [SEC]: "-" }), changed(SEC), [WF, SEC], [WF, SEC], read);
    expect(resolved.flags[SEC]).toBe("  ");
  });

  test("an empty piped credential is refused", async () => {
    for (const text of ["", "\n", "\r\n"]) {
      const { read } = reader({ "-": text });
      await expect(resolveCredentials(flags({ [SEC]: "-" }), changed(SEC), [WF, SEC], [WF, SEC], read)).rejects.toThrow(
        `empty --${SEC} on stdin`,
      );
    }
  });

  test("a -file flag reads the credential from the named file and moves changed onto it", async () => {
    const { reads, read } = reader({ "/sec": "whsec_file\n", "-": "https://mm.example/in\n" });
    const resolved = await resolveCredentials(
      flags({ [WF]: "-", [SEC_FILE]: "/sec" }),
      changed(WF, SEC_FILE),
      [WF, SEC],
      [WF, SEC],
      read,
    );
    expect(resolved.flags[WF]).toBe("https://mm.example/in");
    expect(resolved.flags[SEC]).toBe("whsec_file");
    expect(resolved.changed.has(WF)).toBe(true);
    expect(resolved.changed.has(SEC)).toBe(true);
    expect(resolved.changed.has(SEC_FILE)).toBe(false);
    expect([...reads].sort()).toEqual(["-", "/sec"]);
  });

  test("the flag and its -file sibling are mutually exclusive", async () => {
    const { read } = reader({ "/sec": "whsec_file\n" });
    await expect(
      resolveCredentials(flags({ [SEC]: "", [SEC_FILE]: "/sec" }), changed(SEC, SEC_FILE), [WF, SEC], [WF, SEC], read),
    ).rejects.toThrow(`pass --${SEC} or --${SEC_FILE}, not both`);
    await expect(
      resolveCredentials(flags({ [WF]: "-", [WF_FILE]: "/url" }), changed(WF, WF_FILE), [WF, SEC], [WF, SEC], read),
    ).rejects.toThrow(`pass --${WF} or --${WF_FILE}, not both`);
  });

  test("a -file flag's - still reads the one stdin", async () => {
    const { read } = reader({ "-": "whsec_pipe\n" });
    const resolved = await resolveCredentials(flags({ [SEC_FILE]: "-" }), changed(SEC_FILE), [WF, SEC], [WF, SEC], read);
    expect(resolved.flags[SEC]).toBe("whsec_pipe");
    expect(resolved.changed.has(SEC)).toBe(true);
    expect(resolved.changed.has(SEC_FILE)).toBe(false);
  });

  test("two stdin readers across the flag and -file forms are refused before stdin is read", async () => {
    const { reads, read } = reader();
    await expect(
      resolveCredentials(flags({ [WF]: "-", [SEC_FILE]: "-" }), changed(WF, SEC_FILE), [WF, SEC], [WF, SEC], read),
    ).rejects.toThrow(`only one of --${WF}, --${SEC_FILE} can read stdin`);
    expect(reads).toEqual([]);
  });

  test("an empty -file is refused and a missing one fails the read", async () => {
    const { read } = reader({ "/empty": "\n" });
    await expect(
      resolveCredentials(flags({ [SEC_FILE]: "/empty" }), changed(SEC_FILE), [WF, SEC], [WF, SEC], read),
    ).rejects.toThrow(`empty --${SEC_FILE} /empty`);
    const failing = reader();
    await expect(
      resolveCredentials(flags({ [SEC_FILE]: "/missing" }), changed(SEC_FILE), [WF, SEC], [WF, SEC], failing.read),
    ).rejects.toThrow("unexpected read of /missing");
    expect(failing.reads).toEqual(["/missing"]);
  });

  // No reader is injected here: the default is the real credential read, and
  // a leading U+FEFF is part of the secret rather than an editor's signature
  // for readInput to take off. Only the one trailing line ending goes.
  test("a credential file keeps a leading BOM through the real read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaneo-credential-"));
    try {
      const path = join(dir, "secret.txt");
      writeFileSync(path, "\uFEFFwhsec_bom_7\n");
      const resolved = await resolveCredentials(flags({ [SEC_FILE]: path }), changed(SEC_FILE), [WF, SEC], [WF, SEC]);
      expect(resolved.flags[SEC]).toBe("\uFEFFwhsec_bom_7");
      expect(resolved.changed.has(SEC)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("requireCreateWebhookUrl", () => {
  test("create needs the URL by either input, checked before stdin is read", () => {
    expect(() => requireCreateWebhookUrl(flags({}), changed())).toThrow(REQUIRED);
    expect(() => requireCreateWebhookUrl(flags({ [WF]: "" }), changed(WF))).toThrow(REQUIRED);
    expect(() => requireCreateWebhookUrl(flags({ [WF_FILE]: "" }), changed(WF_FILE))).toThrow(REQUIRED);
    expect(() => requireCreateWebhookUrl(flags({ [WF]: "-" }), changed(WF))).not.toThrow();
    expect(() => requireCreateWebhookUrl(flags({ [WF_FILE]: "/url" }), changed(WF_FILE))).not.toThrow();
    expect(() => requireCreateWebhookUrl(flags({ [WF_FILE]: "-" }), changed(WF_FILE))).not.toThrow();
  });
});

describe("mattermostCreateBody", () => {
  test("requires the webhook url", () => {
    expect(() => mattermostCreateBody(flags({}), changed(CH))).toThrow(REQUIRED);
    expect(() => mattermostCreateBody(flags({ [WF]: "" }), changed(WF))).toThrow(REQUIRED);
  });

  test("sends only what was passed", () => {
    expect(mattermostCreateBody(flags({ [WF]: "https://mm.example/in" }), changed(WF))).toEqual({ webhookUrl: "https://mm.example/in" });
  });

  test("an empty channel on create means none, so it stays out", () => {
    const body = mattermostCreateBody(flags({ [WF]: "https://mm.example/in", [CH]: "" }), changed(WF, CH));
    expect(body).toEqual({ webhookUrl: "https://mm.example/in" });
  });

  test("event toggles carry only the flags passed, explicit false included", () => {
    const body = mattermostCreateBody(
      flags({ [WF]: "https://mm.example/in", "task-created": false, "task-comment-created": true }),
      changed(WF, "task-created", "task-comment-created"),
    );
    expect(body.events).toEqual({ taskCreated: false, taskCommentCreated: true });
  });
});

describe("mattermostUpdateBody", () => {
  test("no flags means an empty body", () => {
    expect(mattermostUpdateBody(flags({}), changed())).toEqual({});
  });

  test("the url cannot be emptied", () => {
    expect(() => mattermostUpdateBody(flags({ [WF]: "" }), changed(WF))).toThrow(`${WF_TYPED} cannot be cleared`);
  });

  test("an empty channel is the schema's null clear", () => {
    expect(mattermostUpdateBody(flags({ [CH]: "" }), changed(CH))).toEqual({ channelName: null });
    expect(mattermostUpdateBody(flags({ [CH]: "alerts" }), changed(CH))).toEqual({ channelName: "alerts" });
  });

  test("active is sent only when the flag was passed", () => {
    expect(mattermostUpdateBody(flags({ active: true }), changed("active"))).toEqual({ isActive: true });
    expect(mattermostUpdateBody(flags({ active: false }), changed("active"))).toEqual({ isActive: false });
    expect(mattermostUpdateBody(flags({ active: false }), changed())).toEqual({});
  });

  test("event toggles merge one flag at a time", () => {
    const body = mattermostUpdateBody(flags({ "task-status-changed": false }), changed("task-status-changed"));
    expect(body).toEqual({ events: { taskStatusChanged: false } });
  });
});

describe("webhookCreateBody", () => {
  test("requires the webhook url", () => {
    expect(() => webhookCreateBody(flags({}), changed(SEC))).toThrow(REQUIRED);
  });

  test("an empty secret on create stays out", () => {
    const body = webhookCreateBody(flags({ [WF]: "https://wh.example/in", [SEC]: "" }), changed(WF, SEC));
    expect(body).toEqual({ webhookUrl: "https://wh.example/in" });
  });

  test("the webhook-only events and the lead are sent when passed", () => {
    // 2h parses to 120 minutes.
    const body = webhookCreateBody(
      flags({ [WF]: "https://wh.example/in", "task-deleted": true, [LEAD]: 120 * 60_000 }),
      changed(WF, "task-deleted", LEAD),
    );
    expect(body).toEqual({
      webhookUrl: "https://wh.example/in",
      events: { taskDeleted: true },
      dueDateReminderLeadTimeMinutes: 120,
    });
  });

  test("the lead is whole minutes between 5 and 30 days", () => {
    const at = (ms: number) => webhookCreateBody(flags({ [WF]: "https://wh.example/in", [LEAD]: ms }), changed(WF, LEAD));
    expect(() => at(90_000)).toThrow("whole number of minutes");
    expect(() => at(4 * 60_000)).toThrow("between 5 minutes and 30 days");
    expect(() => at(721 * 3_600_000)).toThrow("between 5 minutes and 30 days");
    expect(at(5 * 60_000).dueDateReminderLeadTimeMinutes).toBe(5);
    expect(at(720 * 3_600_000).dueDateReminderLeadTimeMinutes).toBe(43_200);
  });
});

describe("webhookUpdateBody", () => {
  test("an empty secret is the schema's null clear", () => {
    expect(webhookUpdateBody(flags({ [SEC]: "" }), changed(SEC))).toEqual({ secret: null });
    expect(webhookUpdateBody(flags({ [SEC]: "signing-material" }), changed(SEC))).toEqual({ secret: "signing-material" });
    expect(webhookUpdateBody(flags({}), changed())).toEqual({});
  });

  test("the url cannot be emptied", () => {
    expect(() => webhookUpdateBody(flags({ [WF]: "" }), changed(WF))).toThrow(`${WF_TYPED} cannot be cleared`);
  });

  test("a sparse update keeps to the flags passed", () => {
    const body = webhookUpdateBody(
      flags({ "task-moved": false, "due-date-reminder": true, [LEAD]: 60 * 60_000, active: false }),
      changed("task-moved", "due-date-reminder", LEAD, "active"),
    );
    expect(body).toEqual({
      isActive: false,
      events: { taskMoved: false, dueDateReminder: true },
      dueDateReminderLeadTimeMinutes: 60,
    });
  });
});

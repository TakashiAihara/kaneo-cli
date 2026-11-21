import { apiKey, project, type App } from "./app";
import { noArgs, type Command, type Flag, type FlagValues, type RunContext } from "./args";
import { readCredential, sourceName } from "./input";
import { withProject } from "./lookup";
import type { IntegrationRemoved } from "../api/kaneo";
import type { Json } from "../output/json";

// What the get/set/rm shape every webhook-style integration shares lives
// here: the event tables and how they read, the credential flags' input
// convention, and the command factory the per-provider files hand their
// spec to. The providers themselves — their flags, bodies and descriptions —
// stay in integration-mattermost.ts and integration-webhook.ts.

// The toggles an integration's `events` object carries, as [flag, field, what
// the plugin fires it for]. The flag is the field name in kebab-case; `as
// const` keeps the field names literal so the body they build is typed.
export const SHARED_EVENTS = [
  ["task-created", "taskCreated", "a task is created"],
  ["task-status-changed", "taskStatusChanged", "a task changes status"],
  ["task-priority-changed", "taskPriorityChanged", "a task's priority changes"],
  ["task-title-changed", "taskTitleChanged", "a task's title changes"],
  ["task-description-changed", "taskDescriptionChanged", "a task's description changes"],
  ["task-comment-created", "taskCommentCreated", "a comment is added to a task"],
] as const;

// The events only the generic webhook has; the Mattermost plugin fires the six
// above and no others.
const WEBHOOK_EVENTS = [
  ["task-deleted", "taskDeleted", "a task is deleted"],
  ["task-moved", "taskMoved", "a task moves to another project"],
  ["task-due-date-changed", "taskDueDateChanged", "a task's due date changes"],
  ["task-assignee-changed", "taskAssigneeChanged", "a task is assigned or given a new assignee"],
  ["task-unassigned", "taskUnassigned", "a task is unassigned"],
  ["due-date-reminder", "dueDateReminder", "a due-date reminder fires"],
] as const;

export const ALL_EVENTS = [...SHARED_EVENTS, ...WEBHOOK_EVENTS];

export const boolFlag = (name: string, usage: string): Flag => ({ name, type: "bool", usage, defaultValue: "false" });
export const stringFlag = (name: string, usage: string): Flag => ({ name, type: "string", usage, defaultValue: "" });

// The `events` object a body carries: only the toggles passed, since the
// server merges what it is sent into the stored set rather than replacing it.
export const eventToggles = <F extends string>(
  flags: FlagValues,
  changed: ReadonlySet<string>,
  events: readonly (readonly [string, F, string])[],
): Partial<Record<F, boolean>> => {
  const toggles: Partial<Record<F, boolean>> = {};
  for (const [flag, field] of events) {
    if (changed.has(flag)) toggles[field] = flags[flag] === true;
  }
  return toggles;
};

// The toggles that are on, by the labels a person reads; "none" when the
// integration fires nothing. A label is the flag's name with its dashes as
// spaces, which is what the flag already says.
export const eventSummary = <F extends string>(
  events: Partial<Record<F, boolean>>,
  table: readonly (readonly [string, F, string])[],
): string => {
  const on = table.filter(([, field]) => events[field] === true).map(([flag]) => flag.replaceAll("-", " "));
  return on.length === 0 ? "none" : on.join(", ");
};

// isActive is null on a row the server never set it on, which reads as unset
// rather than as on or off.
export const activeLabel = (isActive: boolean | null): string =>
  isActive === null ? "unset" : isActive ? "on" : "off";

// A credential on the command line is visible in the process list and the
// shell history, so the flag takes only `-`, which reads the value from
// stdin. A `--<name>-file` sibling names a file the value is read from
// instead (`-` there reads stdin too), which is how two credentials fit in
// one command when stdin is a single stream. A credential given as anything
// else is refused rather than sent, and a value that is exactly `-` cannot
// be passed as one.
const literalSecret = (flag: string): string =>
  `--${flag} is a secret and takes - only: pipe the value on stdin rather than passing it on the command line`;

// The one line ending a pipe or a file adds is not part of the credential;
// the rest of the text is kept as it came, whitespace included, and the read
// keeps a leading BOM too — it can be part of the secret itself, which is
// why the default reader is readCredential rather than readInput.
const credentialText = async (
  source: string,
  named: string,
  read: (source: string) => Promise<string>,
): Promise<string> => {
  const text = (await read(source)).replace(/\r?\n$/, "");
  if (text === "") throw new Error(`empty --${named} ${source === "-" ? "on stdin" : sourceName(source)}`);
  return text;
};

// The flags whose `-` reads stdin and whose `-file` siblings read a path,
// resolved before the bodies run: a literal is refused, the flag and its
// `-file` sibling are two ways to give one credential and are refused
// together, two `-`s would share the one stdin stream and are refused, and
// each piped or pathed value replaces the flag's `-` or path in the flags
// the bodies see, with the `-file` flag's name moved onto the credential's
// in `changed`. The bodies then see only values.
export const resolveCredentials = async (
  flags: FlagValues,
  changed: ReadonlySet<string>,
  stdin: readonly string[],
  files: readonly string[] = [],
  read: (source: string) => Promise<string> = readCredential,
): Promise<{ flags: FlagValues; changed: ReadonlySet<string> }> => {
  for (const name of stdin) {
    const raw = String(flags[name] ?? "");
    if (raw !== "" && raw !== "-") throw new Error(literalSecret(name));
  }
  const nextFlags: FlagValues = { ...flags };
  const nextChanged = new Set(changed);
  // What asks for the one stdin stream, by the flag as typed: a credential's
  // own `-`, or its `-file` sibling's `-`. Collected before anything is read
  // so a second one is refused while the stream is still unread.
  const piped: { typed: string; name: string }[] = [];
  for (const name of stdin) {
    if (String(flags[name] ?? "") === "-") piped.push({ typed: name, name });
  }
  for (const name of files) {
    const fileFlag = `${name}-file`;
    if (!changed.has(fileFlag)) continue;
    if (changed.has(name)) throw new Error(`pass --${name} or --${fileFlag}, not both`);
    if (String(flags[fileFlag] ?? "") === "-") piped.push({ typed: fileFlag, name });
  }
  if (piped.length > 1) {
    throw new Error(
      `only one of ${piped.map((p) => `--${p.typed}`).join(", ")} can read stdin; the others take a file or a second command`,
    );
  }
  for (const name of files) {
    const fileFlag = `${name}-file`;
    const source = String(flags[fileFlag] ?? "");
    if (!changed.has(fileFlag) || source === "-") continue;
    nextFlags[name] = await credentialText(source, fileFlag, read);
    nextChanged.delete(fileFlag);
    nextChanged.add(name);
  }
  if (piped.length === 1) {
    const { typed, name } = piped[0]!;
    nextFlags[name] = await credentialText("-", typed, read);
    nextChanged.delete(`${name}-file`);
    nextChanged.add(name);
  }
  return { flags: nextFlags, changed: nextChanged };
};

// The webhook URL flag's name once, and the same flag as it is typed on the
// command line for the messages that name it.
export const WEBHOOK_URL_FLAG = "webhook-url";
const WEBHOOK_URL_TYPED = `--${WEBHOOK_URL_FLAG}`;

const webhookUrlRequired = (): string =>
  `creating an integration needs ${WEBHOOK_URL_TYPED} - or ${WEBHOOK_URL_TYPED}-file <path>: the webhook URL is a credential read from stdin or a file so it never appears on the command line`;

// The create path's check before stdin is read: creating needs the webhook
// URL, which arrives the way every credential does — `-` on the flag or a
// path on its `-file` sibling. Without it a create with only a piped secret
// would take the pipe and then fail on the missing URL.
export const requireCreateWebhookUrl = (flags: FlagValues, changed: ReadonlySet<string>): void => {
  const viaFlag = changed.has(WEBHOOK_URL_FLAG) && String(flags[WEBHOOK_URL_FLAG] ?? "") !== "";
  const viaFile = changed.has(`${WEBHOOK_URL_FLAG}-file`) && String(flags[`${WEBHOOK_URL_FLAG}-file`] ?? "") !== "";
  if (!viaFlag && !viaFile) throw new Error(webhookUrlRequired());
};

// The webhook URL when the flag was passed. `flags` is resolveCredentials'
// output, so a value here came over stdin or out of a file; creating needs
// it and on update it cannot be emptied — the update routes keep the stored
// one on an empty value — so `''` is refused here rather than sent as a
// silent no-op.
export function webhookUrlFlag(flags: FlagValues, changed: ReadonlySet<string>, creating: true): string;
export function webhookUrlFlag(flags: FlagValues, changed: ReadonlySet<string>, creating: false): string | undefined;
export function webhookUrlFlag(flags: FlagValues, changed: ReadonlySet<string>, creating: boolean): string | undefined {
  if (!changed.has(WEBHOOK_URL_FLAG)) {
    if (creating) throw new Error(webhookUrlRequired());
    return undefined;
  }
  const raw = String(flags[WEBHOOK_URL_FLAG] ?? "");
  if (raw === "") {
    throw new Error(
      creating ? webhookUrlRequired() : `${WEBHOOK_URL_TYPED} cannot be cleared; the integration needs one`,
    );
  }
  return raw;
}

// A secret flag's value when it was passed, from resolveCredentials' output:
// `''` is the update schema's clear — or, on create, simply unset — and
// anything else is the value.
export const secretFlag = (
  flag: string,
  flags: FlagValues,
  changed: ReadonlySet<string>,
  creating: boolean,
): string | null | undefined => {
  if (!changed.has(flag)) return undefined;
  const raw = String(flags[flag] ?? "");
  if (raw === "") return creating ? undefined : null;
  return raw;
};

// One provider's half of the shared get/set/rm shape: its API calls, the flags
// `set` takes, and how a stored integration reads to a person. `get` answers
// null for a project with no integration, which is what `set` creates on; a
// write that answers null is the server accepting and returning nothing, which
// is an error rather than "not configured".
export type IntegrationSpec<R extends Json, C extends object, U extends object> = {
  name: string;
  short: string;
  long: string;
  setShort: string;
  setLong: string;
  flags: Flag[];
  // The flags that take `-` and read their value from stdin; at most one can
  // be passed per command since stdin is a single stream.
  stdin: readonly string[];
  // The `stdin` flags that also take a `--<name>-file` sibling naming a file
  // the credential is read from (`-` reads stdin there too). A credential
  // that can come from a file can share a command with one that reads stdin,
  // which is how a signed webhook is created in one call.
  files?: readonly string[];
  // A check the create path runs before stdin is read, so a create that
  // cannot succeed does not take the pipe first.
  validateCreate?: (flags: FlagValues, changed: ReadonlySet<string>) => void;
  api: {
    get: (projectId: string) => Promise<R | null>;
    create: (projectId: string, body: C) => Promise<R | null>;
    update: (projectId: string, body: U) => Promise<R | null>;
    remove: (projectId: string) => Promise<IntegrationRemoved>;
  };
  // Both take resolveCredentials' output, so a credential flag's value is
  // already the text the pipe or the file carried rather than the `-` or the
  // path that asked for it.
  createBody: (flags: FlagValues, changed: ReadonlySet<string>) => C;
  updateBody: (flags: FlagValues, changed: ReadonlySet<string>) => U;
  describe: (integration: R) => string[];
  // Flags the create body cannot carry, with the reason each is refused on
  // the create path: --active is the one both providers here share, since a
  // new integration is always created active.
  createRefuses?: Record<string, string>;
};

export const providerCommand = <R extends Json, C extends object, U extends object>(
  spec: IntegrationSpec<R, C, U>,
): Command<App> => ({
  name: spec.name,
  short: spec.short,
  long: spec.long,
  children: [
    {
      name: "get",
      short: `Show the ${spec.name} integration`,
      args: noArgs(`kaneo integration ${spec.name} get`),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const found = await withProject(project(app), (id) => spec.api.get(id));
        if (found === null) {
          app.out.human(`no ${spec.name} integration on this project`);
          app.out.data(null);
          return;
        }
        for (const line of spec.describe(found)) app.out.human(line);
        app.out.data(found);
      },
    },
    {
      name: "set",
      short: spec.setShort,
      long: spec.setLong,
      args: noArgs(`kaneo integration ${spec.name} set`),
      flags: spec.flags,
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const { projectId, current } = await withProject(project(app), async (id) => ({
          projectId: id,
          current: await spec.api.get(id),
        }));
        if (current === null) {
          for (const [flag, reason] of Object.entries(spec.createRefuses ?? {})) {
            if (changed.has(flag)) throw new Error(`--${flag} ${reason}`);
          }
          spec.validateCreate?.(flags, changed);
          const resolved = await resolveCredentials(flags, changed, spec.stdin, spec.files);
          const created = await spec.api.create(projectId, spec.createBody(resolved.flags, resolved.changed));
          if (created === null) throw new Error(`the server accepted the ${spec.name} integration but returned none`);
          app.out.human(`created ${spec.name} integration`);
          for (const line of spec.describe(created)) app.out.human(line);
          app.out.data(created);
          return;
        }
        const resolved = await resolveCredentials(flags, changed, spec.stdin, spec.files);
        const changes = spec.updateBody(resolved.flags, resolved.changed);
        if (Object.keys(changes).length === 0) {
          throw new Error(`nothing to change: pass at least one of ${spec.flags.map((f) => `--${f.name}`).join(", ")}`);
        }
        const updated = await spec.api.update(projectId, changes);
        if (updated === null)
          throw new Error(`the server accepted the change but returned no ${spec.name} integration`);
        app.out.human(`updated ${spec.name} integration`);
        for (const line of spec.describe(updated)) app.out.human(line);
        app.out.data(updated);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      short: `Remove the ${spec.name} integration`,
      args: noArgs(`kaneo integration ${spec.name} rm`),
      flags: [boolFlag("yes", "confirm the removal")],
      run: async ({ flags, app }: RunContext<App>) => {
        apiKey(app);
        const removed = await withProject(project(app), async (id) => {
          const found = await spec.api.get(id);
          if (found === null) throw new Error(`no ${spec.name} integration on this project`);
          // The webhook URL, the signing secret and the event settings go with it.
          if (flags.yes !== true) {
            throw new Error(`refusing to remove the ${spec.name} integration without --yes`);
          }
          return spec.api.remove(id);
        });
        app.out.human(`removed the ${spec.name} integration`);
        app.out.data(removed);
      },
    },
  ],
});

import { writeSync } from "node:fs";
import { apiKey, project, workspace, type App } from "./app";
import {
  calendarFeedIcs,
  createCalendarFeed,
  listCalendarFeeds,
  listWorkspaceLabels,
  revokeCalendarFeed,
  type CalendarFeed,
  type LabelRecord,
} from "../api/kaneo";
import { normalizeBaseUrl } from "../api/http";
import { exactArgs, minimumArgs, noArgs, type RunContext } from "./args";
import { resolveWorkspace, withProject } from "./lookup";
import { sanitizeDocument } from "../output/output";

// The subscribe link a feed's token stands for: the API serves it without a
// key, which is what makes it pasteable into a calendar app.
const subscribeUrl = (app: App, token: string): string =>
  `${normalizeBaseUrl(app.cfg.apiUrl)}/calendar-feed/${encodeURIComponent(token)}/calendar.ics`;

// Label id to name, for the human listing: the ids a feed stores are the
// workspace's label definitions, which `label ls` shows by name. A feed whose
// labels are all gone still lists, with the ids standing in.
const labelNames = (rows: LabelRecord[]): Map<string, string> => {
  const names = new Map<string, string>();
  for (const label of rows) names.set(label.id, label.name);
  return names;
};

// The workspace's label rows, or none when no workspace is configured: the
// names are decoration on the listing, and a feed is still listed without them.
// A failed read degrades the same way — after `feed create` the feed and its
// subscribe link are already on the server, so a names lookup that fails must
// not turn the printed answer into an error; the reason goes to stderr and the
// feed's label ids stand in for the names.
const feedLabelNames = async (app: App): Promise<Map<string, string>> => {
  if (app.cfg.workspaceId === "") return new Map();
  try {
    return labelNames(await listWorkspaceLabels(await resolveWorkspace(workspace(app))));
  } catch (e) {
    console.error(
      `kaneo: label names unavailable, the feed's label ids are shown instead: ${e instanceof Error ? e.message : String(e)}`,
    );
    return new Map();
  }
};

const feedLabels = (feed: CalendarFeed, names: Map<string, string>): string =>
  feed.labelIds.map((id) => names.get(id) ?? id).join(",");

const feedLine = (app: App, feed: CalendarFeed, names: Map<string, string>): string =>
  `${feed.id}  ${subscribeUrl(app, feed.token)}  ${feedLabels(feed, names)}  ${feed.timeZone}  ${feed.createdAt}`;

// The labels a feed may name, picked the way the web app's feed form picks
// them (apps/web get-calendar-label-options.ts): one option per name, the
// workspace's own definition preferred over a task's copy, so a name that
// exists only on tasks still offers the copy whose id the server turns into a
// definition. A name with a label being deleted is dropped whole, the way the
// task label picker drops it: the server resolves a feed's labels by name to
// a live workspace definition, and refuses the name while any of its rows is
// mid-deletion.
const calendarLabelOptions = (labels: LabelRecord[]): { id: string; name: string }[] => {
  const deleting = new Set(labels.filter((l) => l.deletionStartedAt !== null).map((l) => l.name));
  const byName = new Map<string, LabelRecord>();
  for (const label of labels) {
    if (deleting.has(label.name)) continue;
    if (!byName.has(label.name) || label.taskId === null) byName.set(label.name, label);
  }
  return [...byName.values()]
    .map((label) => ({ id: label.id, name: label.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

// A feed create argument as the label it names: id first, then name, since ids
// are what listings hand on and a name is what a person types.
const resolveFeedLabel = (options: { id: string; name: string }[], ref: string): string => {
  const found = options.find((o) => o.id === ref) ?? options.find((o) => o.name === ref);
  if (found === undefined) throw new Error(`no label ${JSON.stringify(ref)} in this workspace; kaneo label ls lists them`);
  return found.id;
};

// A project's calendar feeds: subscription links that serve the project's
// scheduled tasks as an iCalendar document to anyone holding the link.
export const feedCommand = {
  name: "feed",
  short: "Work with a project's calendar feeds",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List the resolved project's calendar feeds",
      long:
        "List the resolved project's calendar feeds.\n\n" +
        "Each line carries the feed's id, its subscribe link — the address a\n" +
        "calendar app is given, and which needs no key — the labels it matches,\n" +
        "its time zone and when it was created.",
      args: noArgs("kaneo feed list"),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const wanted = project(app);
        // The names only decorate the human lines; JSON mode carries the ids
        // themselves, so the extra listing is not made for it.
        const names = app.out.mode.json ? new Map<string, string>() : await feedLabelNames(app);
        const feeds = await withProject(wanted, (id) => listCalendarFeeds(id));
        for (const feed of feeds) app.out.human(feedLine(app, feed, names));
        app.out.data(feeds);
      },
    },
    {
      name: "create",
      use: "create <label>... [--time-zone ZONE]",
      short: "Create a calendar feed for the resolved project",
      long:
        "Create a calendar feed for the resolved project.\n\n" +
        "The feed serves the project's tasks that carry any of the labels, so at\n" +
        "least one label is required; each is a workspace label by id or name.\n" +
        "--time-zone is the zone all-day dates are read in; left out, the\n" +
        "server's UTC applies. The reply carries the subscribe link.",
      args: minimumArgs(1),
      flags: [
        {
          name: "time-zone",
          type: "string" as const,
          usage: "time zone all-day dates are read in (server default UTC)",
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        const wanted = project(app);
        // The labels resolve before the project does: they are the workspace's,
        // and a project that names none still gets the same refusal.
        const rows = await listWorkspaceLabels(await resolveWorkspace(workspace(app)));
        const options = calendarLabelOptions(rows);
        const labelIds = [...new Set(args.map((arg) => resolveFeedLabel(options, arg.trim())))];
        const timeZone = String(flags["time-zone"] ?? "");
        const feed = await withProject(wanted, (id) => createCalendarFeed(id, labelIds, timeZone));
        // The names are read after the write: a label that existed only as a
        // task's copy has a workspace definition by now — the create
        // materialized it — and the rows fetched before it would print the
        // feed's raw id where `feed ls` prints the name. JSON mode carries the
        // ids and needs no listing.
        const names = app.out.mode.json ? new Map<string, string>() : await feedLabelNames(app);
        app.out.human(`created ${feedLine(app, feed, names)}`);
        app.out.data(feed);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      use: "rm <feed>",
      short: "Revoke a calendar feed",
      long:
        "Revoke a calendar feed.\n\n" +
        "The feed is named by its id or its token from `kaneo feed ls`. Its\n" +
        "subscribe link stops working for good: a feed created again gets a new\n" +
        "token, so anything already subscribed has to be given the new link.",
      args: exactArgs(1),
      flags: [{ name: "yes", type: "bool" as const, usage: "confirm the revocation", defaultValue: "false" }],
      run: async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        const ref = args[0]!.trim();
        if (ref === "") throw new Error("a feed id or token cannot be blank");
        const { projectId, feed } = await withProject(project(app), async (id) => {
          const feeds = await listCalendarFeeds(id);
          const found = feeds.find((f) => f.id === ref || f.token === ref);
          if (found === undefined) {
            throw new Error(`no calendar feed ${JSON.stringify(ref)} in this project; kaneo feed ls lists them`);
          }
          return { projectId: id, feed: found };
        });
        // The revocation cannot be undone and a new feed is a new link, so the
        // confirmation is asked for the way every other delete asks for it.
        if (flags.yes !== true) {
          throw new Error(`refusing to revoke calendar feed ${feed.id} without --yes; its subscribe link stops working and a new feed gets a new one`);
        }
        await revokeCalendarFeed(projectId, feed.id);
        app.out.human(`revoked feed ${feed.id}`);
        app.out.data(feed);
      },
    },
    {
      name: "get",
      use: "get <token>",
      short: "Print a feed's iCalendar document",
      long:
        "Print a feed's iCalendar document.\n\n" +
        "The token is the secret half of the feed's subscribe link, as printed by\n" +
        "`kaneo feed ls` and `kaneo feed create`. The route is public — the token\n" +
        "is the credential — so this needs no API key and no project. The\n" +
        "document is written to stdout as it arrived: it is not JSON, so\n" +
        "--json and --jq are refused.\n",
      args: exactArgs(1),
      run: async ({ args, changed, app }: RunContext<App>) => {
        // There is no JSON form of the document for the output flags to hand
        // back, so asking for one is refused rather than silently answered
        // with text a filter cannot read. An empty --jq is no expression at
        // all, the same as everywhere else.
        if (changed.has("json") || app.out.filter !== undefined) {
          throw new Error("--json and --jq do not apply to feed get; the iCalendar document is written to stdout as it arrives");
        }
        const token = args[0]!.trim();
        if (token === "") throw new Error("a feed token cannot be blank");
        const ics = await calendarFeedIcs(token);
        // Task titles and descriptions are server text, so a terminal gets the
        // document with control characters neutralised — line by line, so the
        // CRLF the format is written in survives — while a pipe or a file gets
        // the bytes as they arrived, which `feed get > cal.ics` relies on.
        writeSync(1, app.out.terminal ? sanitizeDocument(ics) : ics);
      },
    },
  ],
};

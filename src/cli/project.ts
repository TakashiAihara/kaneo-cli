import { writeSync } from "node:fs";
import { apiKey, project, projects, workspace, type App } from "./app";
import {
  archived,
  createProject,
  currentUser,
  deleteProject,
  deleteProjectBackground,
  getProject,
  getProjectBackground,
  listMembers,
  listProjectsIn,
  listWorkspaces,
  moveProject,
  reorderProjects,
  setProjectArchived,
  setProjectBackground,
  updateProject,
  type Project,
  type ProjectChanges,
  type User,
} from "../api/kaneo";
import { exactArgs, maximumArgs, minimumArgs, noArgs, type FlagValues } from "./args";
import { sourceName } from "./input";
import { allProjects, firstMatch, resolveWorkspace, slugOr, unlistedMessage, withProject, type ProjectIn, type Unlisted } from "./lookup";
import { ReportedError, shellWord } from "../output/output";
import { KaneoApiError } from "../api/http";
import * as store from "../session/store";

// `archive` and `unarchive` are the same request with the opposite verb, so they
// are built from one place rather than written out twice.
//
// Archiving is how a finished project leaves the board. Dropping it from the repo
// map would do that too, but it would also lose the record that the repository
// ever had that work, so the board filters on the server's own archived flag
// instead and the mapping stays put. Nothing is deleted, and unarchive puts it
// back.
const archiveCommand = (verb: "archive" | "unarchive") => {
  const archived = verb === "archive";
  return {
    name: verb,
    use: `${verb} [project-id]`,
    short: `${verb === "archive" ? "A" : "U"}${verb.slice(1)} a project`,
    args: maximumArgs(1),
    run: async ({ args, app }: { args: string[]; app: App }) => {
      apiKey(app);
      const id = args[0] ?? project(app);
      const doing = archived ? "archiving a project" : "unarchiving a project";
      const projectId = await withProject(id, async (projectId) => {
        await setProjectArchived(projectId, archived).catch(refused(doing, "update", () => projectWorkspace(projectId)));
        return projectId;
      });
      app.out.human(`${archived ? "archived" : "unarchived"} ${id}`);
      app.out.data({ archived, project: projectId });
    },
  };
};

// One project, named the way a listing prints it.
//
// The slug is what -p and <slug>#N take, so every line carries it, except for a
// project with none (the server takes an empty one), which has nothing to show.
// Across workspaces a project is only unique inside its own, so the workspace it is in
// follows, spelled out so it cannot be read as the archived marker.
const projectLine = (project: Project, workspaceName = ""): string => {
  const columns = [project.id, project.name];
  if (project.slug !== "") columns.push(`[${project.slug}]`);
  if (workspaceName !== "") columns.push(`(workspace: ${workspaceName})`);
  if (archived(project)) columns.push("(archived)");
  return columns.join("  ");
};

// A project as the JSON report carries it when it came from more than one
// workspace: the same fields as a single-workspace listing, plus the workspace it
// belongs to at the end, where a reader looking for it will look last.
const named = ({ project, workspaceName }: ProjectIn) => ({ ...project, workspaceName });

// The configured project values that name the project just deleted, as the
// settings spelled them — an id, a slug or a name. Empty when the settings name
// none (or cannot be read), which is the ordinary case outside a checkout.
const staleDefault = (app: App, found: Project): string[] => {
  let configured: string[];
  try {
    configured = projects(app);
  } catch {
    return [];
  }
  return configured.filter((value) => {
    const folded = value.toLowerCase();
    return value === found.id || folded === found.slug.toLowerCase() || folded === found.name.toLowerCase();
  });
};

// Kaneo compares project keys NFKC-normalised and lower-cased (project-key.ts
// in the API), so the check made before a create has to fold them the same way.
const keyOf = (slug: string): string => slug.normalize("NFKC").toLowerCase();

// The key a name derives, by the rule the Kaneo web app uses for a project made
// there (generateProjectSlug in apps/web/src/lib/generate-project-id.ts), so a
// project made here gets the kind of key its users already see: the first three
// letters of a single word, or the initials of the first three words, upper
// case, from any script. Every task identifier of the project starts with it,
// and the server takes an empty one, so a name with no letter or number derives
// nothing and that is reported rather than sent.
export const deriveSlug = (name: string): string => {
  const words = name
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));

  if (words.length === 0) return "";

  // By code point, so a letter outside the BMP is not cut in half, and from the
  // first letter or number, since a key has to start with one to be typed back.
  const fromFirst = (word: string) => {
    const points = Array.from(word);
    return points.slice(points.findIndex((c) => /[\p{L}\p{N}]/u.test(c)));
  };
  if (words.length === 1) return fromFirst(words[0]!).slice(0, 3).join("");
  return words
    .slice(0, 3)
    .map((word) => fromFirst(word)[0])
    .join("");
};

// The description the create route cannot carry, written by the update that
// follows the create. The project exists by then, so a failure names it: a
// message that only said the description could not be set would leave a project
// behind that nothing says is there.
const withDescription = async (created: Project, description: string): Promise<Project> => {
  try {
    const { after } = await updateProject(created.id, { description });
    return after;
  } catch (e) {
    // A 403 here means project update would be refused the same way, so the
    // line says why rather than suggesting it.
    const why = await permissionHint(e, "setting a description", "update", async () => created.workspaceId);
    const message =
      why === undefined
        ? `created project ${created.id} but could not set its description: ${(e as Error).message}; set it with \`kaneo project update ${shellWord(created.id)} -d TEXT\``
        : `created project ${created.id} but could not set its description: ${(e as Error).message}: ${why}`;
    // The project exists either way, so the JSON error carries its id as a
    // field: inside the prose alone a script cannot tell what was made.
    throw new ReportedError(message, { projectId: created.id });
  }
};

// The projects in a workspace, and the changes to one of them.
export const projectCommand = {
  name: "project",
  aliases: ["proj"],
  short: "Work with projects",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List the projects in a workspace",
      args: noArgs("kaneo project list"),
      flags: [
        {
          name: "archived",
          type: "bool" as const,
          usage: "include archived projects, so one can be found again to unarchive",
          defaultValue: "false",
        },
        {
          name: "all-workspaces",
          shorthand: "A",
          type: "bool" as const,
          usage: "list every workspace the key can reach, naming the workspace each project is in; cannot be combined with -w",
          defaultValue: "false",
        },
      ],
      run: async ({ flags, app }: { flags: FlagValues; app: App }) => {
        apiKey(app);
        const includeArchived = flags.archived === true;
        const acrossAll = flags["all-workspaces"] === true;
        if (acrossAll && app.flags.workspaceId !== "") {
          throw new Error("--all-workspaces lists every workspace, so it cannot be narrowed with --workspace");
        }
        // One list either way. Only whether a workspace is part of each entry
        // differs, and it can only be named when the listing covers more than one.
        let unlisted: Unlisted[] = [];
        let found: ProjectIn[];
        if (acrossAll) {
          ({ found, unlisted } = await allProjects(includeArchived));
        } else {
          found = (await listProjectsIn(await resolveWorkspace(workspace(app)), includeArchived)).map(
            (project) => ({ project, workspaceName: "" }),
          );
        }
        for (const { project, workspaceName } of found) app.out.human(projectLine(project, workspaceName));
        app.out.data(acrossAll ? found.map(named) : found.map((entry) => entry.project));
        // After the listing, so what could be read is still printed; the exit
        // status and stderr say that it is not all there is.
        if (unlisted.length > 0) throw new Error(`the projects listed above are incomplete: ${unlistedMessage(unlisted)}`);
      },
    },
    {
      name: "find",
      use: "find <text>",
      short: "Find projects by name or slug, in every workspace",
      // Substring rather than an exact match, because what is being searched for
      // is half-remembered: `find be` has to reach `Beta`. Archived projects are
      // included, since one that has been archived is exactly the one somebody is
      // most often looking for.
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const wanted = args[0]!.toLowerCase();
        const everywhere = await allProjects(true);
        const found = everywhere.found.filter(
          (p) =>
            p.project.name.toLowerCase().includes(wanted) || p.project.slug.toLowerCase().includes(wanted),
        );
        const { unlisted } = everywhere;
        if (found.length === 0) {
          const none = `no project matches ${JSON.stringify(args[0])}`;
          throw new Error(unlisted.length === 0 ? none : `${none} in the workspaces that could be listed; ${unlistedMessage(unlisted)}`);
        }
        for (const { project, workspaceName } of found) app.out.human(projectLine(project, workspaceName));
        app.out.data(found.map(named));
        if (unlisted.length > 0) throw new Error(`the projects listed above are incomplete: ${unlistedMessage(unlisted)}`);
      },
    },
    {
      name: "get",
      use: "get [project-id]",
      short: "Show one project",
      // The id falls back to the resolved project, which is what makes `project
      // get` usable with no argument inside a repository.
      args: maximumArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const found = await withProject(args[0] ?? project(app), (id) => getProject(id));
        app.out.human(`${found.id}  ${found.name}`);
        if (found.description !== "") app.out.human(found.description);
        app.out.data(found);
      },
    },
    {
      name: "create",
      use: "create <name | --name NAME>",
      short: "Create a project in a workspace",
      // Several words are one name: `project create Alpha Two` names the project
      // "Alpha Two" rather than complaining about a second argument. --name is
      // the other way to give it, as project update takes it, so the arguments
      // are checked in run, where the flag can be seen.
      flags: [
        { name: "name", type: "string" as const, usage: "project name, instead of the words after create", defaultValue: "" },
        { name: "icon", type: "string" as const, usage: "icon name (default Layers)", defaultValue: "" },
        {
          name: "slug",
          type: "string" as const,
          usage: "url slug, the prefix of task identifiers (default: derived from the name, as the web app does)",
          defaultValue: "",
        },
        { name: "description", shorthand: "d", type: "string" as const, usage: "project description", defaultValue: "" },
      ],
      run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        if (changed.has("name") && args.length > 0) throw new Error("give the name once: as words after create or as --name, not both");
        if (!changed.has("name")) minimumArgs(1)(args);
        const name = changed.has("name") ? String(flags.name ?? "") : args.join(" ");
        if (changed.has("name") && name.trim() === "") throw new Error("empty --name");
        apiKey(app);
        const workspaceId = await resolveWorkspace(workspace(app));
        // A slug that was given is the caller's own spelling of the prefix every
        // task identifier will carry, so it is trimmed and sent as it was typed.
        const given = String(flags.slug ?? "").trim();
        const slug = given === "" ? deriveSlug(name) : given;
        if (slug === "") throw new Error(`cannot derive a slug from the name ${JSON.stringify(name)}: pass --slug`);
        // A derived key is one to three characters, so two names share one
        // easily (Alpha Beta, Apple Banana), and a server before v2.31 takes the
        // second without a word. A key the caller typed is theirs to answer for.
        if (given === "") {
          const taken = (await listProjectsIn(workspaceId, true)).find((p) => keyOf(p.slug) === keyOf(slug));
          if (taken !== undefined) {
            throw new Error(`the slug ${slug} derived from the name is used by project ${taken.id} (${taken.name}): pass --slug`);
          }
        }
        const created = await createProject({
          name,
          workspaceId,
          icon: String(flags.icon ?? ""),
          slug,
        });
        const description = String(flags.description ?? "");
        // Without one asked for this is the project as the create left it, and
        // only one request is made.
        const saved = description === "" ? created : await withDescription(created, description);
        app.out.human(`created ${saved.id}  ${saved.name}`);
        app.out.human(`  task identifiers start with ${saved.slug}`);
        app.out.data(saved);
      },
    },
    {
      name: "update",
      use: "update <project-id>",
      short: "Change a project's name, slug, description or icon; the rest is kept",
      long:
        "Change a project's name, slug, description or icon; the rest is kept.\n\n" +
        "With --json the report has from, to and unread: the fields the read before\n" +
        "the write lacked, whose from is \"\". A description the read sent as null was\n" +
        "read, and is not among them.",
      // The id is required rather than resolved like `project get`: resolution
      // falls back to .kaneo.json and the repos map, so an update typed inside a
      // checkout would quietly hit whichever project that repo maps to.
      args: exactArgs(1),
      flags: [
        { name: "name", type: "string" as const, usage: "new name", defaultValue: "" },
        {
          name: "slug",
          type: "string" as const,
          usage: "new url slug (the prefix of task identifiers)",
          defaultValue: "",
        },
        {
          name: "description",
          shorthand: "d",
          type: "string" as const,
          usage: "new description; empty clears it",
          defaultValue: "",
        },
        { name: "icon", type: "string" as const, usage: "new icon name", defaultValue: "" },
      ],
      run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        // Only a flag that was passed is a change: `--description ""` clears the
        // description, and leaving the flag out has to keep it.
        const changes: ProjectChanges = {};
        for (const field of ["name", "slug", "description", "icon"] as const) {
          if (changed.has(field)) changes[field] = String(flags[field] ?? "");
        }
        if (Object.keys(changes).length === 0) {
          throw new Error("nothing to change: pass --name, --slug, --description or --icon");
        }

        apiKey(app);
        // The read of the project comes first inside updateProject, so a value the
        // server does not know is retried before anything is written rather than
        // after.
        const { before, after, unread, nulled } = await withProject(args[0]!, (id) =>
          updateProject(id, changes).catch(refused("updating a project", "update", () => projectWorkspace(id))),
        );
        app.out.human(`updated ${after.id}`);
        for (const [field, from, to] of [
          ["name", before.name, after.name],
          ["slug", before.slug, after.slug],
          ["description", before.description, after.description],
          ["icon", before.icon, after.icon],
        ] as const) {
          const notRead = unread.includes(field);
          if (from === to && !notRead) continue;
          // A field the reply sent as null was read, as no value; only one left
          // out entirely is "not read".
          const was = notRead ? (nulled.includes(field) ? "null" : "(not read)") : JSON.stringify(from);
          app.out.human(`  ${field}  ${was} -> ${JSON.stringify(to)}`);
        }
        // The slug is the prefix of every task identifier, so changing it renames
        // them all and the reader has to be told. A slug the read lacked leaves
        // no before to compare with, and whether it changed is then unknown —
        // the write's reply having one does not say what it was.
        if (unread.includes("slug")) {
          app.out.human(`  task identifiers may now start with ${after.slug}; the slug was not read, so whether it changed is unknown`);
        } else if (before.slug !== after.slug) app.out.human(`  task identifiers now start with ${after.slug}`);
        // A map's keys come out sorted, which is the order the report has.
        app.out.data({ from: before, to: after, unread });
      },
    },
    {
      name: "move",
      use: "move <project> --to <workspace>",
      short: "Move a project to another workspace",
      long:
        "Move a project to another workspace.\n\n" +
        "The project keeps its id and moves with its tasks. The server refuses\n" +
        "the move when the destination already has a project with the same key,\n" +
        "or when a task in it is related to a task in another project, and it\n" +
        "unassigns the tasks whose assignee is not a member of the destination\n" +
        "workspace — the count is in the reply.\n\n" +
        "The project is named the way `project rm` names it — required rather\n" +
        "than resolved from the settings, since a move typed inside a checkout\n" +
        "would otherwise hit whichever project that repo maps to. --to is a\n" +
        "workspace id, slug or name, matched the way --workspace is.",
      args: exactArgs(1),
      flags: [{ name: "to", type: "string" as const, usage: "destination workspace id, slug or name", defaultValue: "" }],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        const target = String(flags.to ?? "");
        if (target === "") throw new Error("no destination: pass --to <workspace>");
        apiKey(app);
        // The destination is resolved before the project is tried: a bad --to
        // is reported without a project lookup, and the workspace listing is
        // one small request either way.
        const workspaceId = await resolveWorkspace(target);
        const moved = await withProject(args[0]!, (id) =>
          moveProject(id, workspaceId).catch(moveRefused(id, workspaceId)),
        );
        app.out.human(`moved ${moved.id}  ${moved.name}${moved.slug === "" ? "" : ` [${moved.slug}]`}  to ${workspaceId}`);
        if (moved.unassignedTaskCount > 0) {
          app.out.human(`  ${moved.unassignedTaskCount} task(s) lost their assignee: not a member of the destination workspace`);
        }
        app.out.data(moved);
      },
    },
    archiveCommand("archive"),
    archiveCommand("unarchive"),
    {
      name: "rm",
      aliases: ["delete"],
      use: "rm <project>",
      short: "Delete a project and everything in it",
      long:
        "Delete a project and everything in it.\n\n" +
        "Archiving is the reversible way to take a project off the board; this one\n" +
        "leaves nothing behind to bring back.",
      // Required rather than resolved from the settings, as `project update` is:
      // resolution falls back to .kaneo.json and the repos map, and a delete typed
      // inside a checkout would quietly take whichever project that repo maps to.
      // What is given is still resolved the way the rest of the CLI resolves a
      // project — by id, slug or name across the workspaces the key can reach —
      // so the refusal has to name the project that was read.
      args: exactArgs(1),
      flags: [{ name: "yes", type: "bool" as const, usage: "confirm the deletion", defaultValue: "false" }],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const found = await withProject(args[0]!, (id) => getProject(id));
        // Everything in the project goes with it — its tasks, their comments and
        // links, its columns, its workflow rules — and the server keeps no copy,
        // so there is nothing to restore from; archive is the reversible way off
        // the board. A name or a slug was accepted here, so the refusal says
        // which project it resolved to rather than echoing the word typed — and
        // which workspace it is in, since the lookup spans every workspace the
        // key reaches and the same name can live in two of them.
        if (flags.yes !== true) {
          const inWorkspace = await listWorkspaces()
            .then((all) => all.find((w) => w.id === found.workspaceId)?.name ?? found.workspaceId)
            .catch(() => found.workspaceId);
          throw new Error(
            `refusing to delete project ${found.name}${found.slug === "" ? "" : ` [${found.slug}]`} (${found.id}) in workspace ${JSON.stringify(inWorkspace)} without --yes; \`kaneo project archive ${shellWord(found.id)}\` keeps it`,
          );
        }
        const deleted = await deleteProject(found.id).catch(refused("deleting a project", "delete", async () => found.workspaceId));
        // Named as it was read, since that is the project the confirmation spoke
        // for; the reply is the server's own record of what it removed, and that
        // is what the report carries.
        app.out.human(`deleted ${found.id}  ${found.name}`);
        // The settings may still resolve to the project just deleted, and the
        // next command that asks for the default gets the server's "Workspace ID
        // could not be determined" rather than this explanation.
        const stale = staleDefault(app, found);
        if (stale.length > 0) {
          app.out.status(
            `note: ${stale.map(shellWord).join(", ")} ${stale.length === 1 ? "is" : "are"} still configured as the project, but it was just deleted; pass --project, set KANEO_PROJECT or update .kaneo.json before the next command`,
          );
        }
        // An attached session keeps the project in its attachment the same way
        // the settings do; its next command fails on the task that went with
        // it, and `session close` is what releases the attachment.
        const held = store.load(store.sessionStore(), store.currentId((name) => process.env[name] ?? ""));
        if (held?.projectId === found.id) {
          app.out.status("note: this session is attached to a task on the project just deleted; `kaneo session close` releases the attachment");
        }
        app.out.data(deleted);
      },
    },
    {
      name: "reorder",
      use: "reorder <project>...",
      short: "Put a workspace's projects in a new order",
      long:
        "Put a workspace's projects in a new order.\n\n" +
        "Every project has to be named exactly once, by id, slug or name. The server\n" +
        "keeps the rank of a project left out of the request and fills the named ones\n" +
        "into the slots around it, so naming a subset would rearrange those slots\n" +
        "rather than move them to the front. An archived project is not named and\n" +
        "keeps the place it holds.",
      args: minimumArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const workspaceId = await resolveWorkspace(workspace(app));
        // The archived projects are read as well, so naming one is reported as
        // what it is rather than as a word the workspace does not hold: the
        // server would take its id, this command will not.
        const order = newProjectOrder(await listProjectsIn(workspaceId, true), args);
        const reply = await reorderProjects(
          workspaceId,
          order.map((project) => project.id),
        ).catch(refused("reordering projects", "update", async () => workspaceId));
        // The reply holds the whole workspace, archived projects included; the
        // ones that are on it are what this command changed the order of.
        for (const project of reply.filter((project) => !archived(project))) app.out.human(projectLine(project));
        app.out.data(reply);
      },
    },
    {
      name: "background",
      short: "Work with a project's board background image",
      children: [
        {
          name: "get",
          use: "get [project]",
          short: "Write the project's background image to stdout",
          long:
            "Write the project's background image to stdout.\n\n" +
            "The image is written as it arrives — it is not JSON, so --json and\n" +
            "--jq are refused, and so is a terminal: the bytes are the server's\n" +
            "to choose and can carry escape sequences. Redirect it to a file\n" +
            "(`> bg.png`) or pipe it on.\n\n" +
            "The project falls back to the resolved one the way `project get` does.",
          args: maximumArgs(1),
          run: async ({ args, changed, app }: { args: string[]; changed: ReadonlySet<string>; app: App }) => {
            // There is no JSON form of an image for the output flags to hand
            // back, so asking for one is refused rather than silently answered
            // with bytes a filter cannot read. An empty --jq is no expression
            // at all, the same as everywhere else.
            if (changed.has("json") || app.out.filter !== undefined) {
              throw new Error("--json and --jq do not apply to project background get; the image is written to stdout as it arrives");
            }
            // The bytes are the server's to choose, so a terminal is refused
            // them the way curl refuses binary output: an image can carry
            // escape sequences, and only a file or a pipe should get them.
            if (app.out.terminal) {
              throw new Error("refusing to write an image to a terminal; redirect it to a file (`> bg.png`) or pipe it on");
            }
            // stdout is the image or nothing, so an error object has no place
            // in a file the bytes are being redirected into: failures are
            // stderr-only from here on.
            app.out.dataOnly();
            apiKey(app);
            const blob = await withProject(args[0] ?? project(app), (id) => getProjectBackground(id));
            // The bytes go out as they arrived: an image is not text, so
            // nothing here may decode or re-encode it. writeSync reports the
            // bytes it took, which on a pipe can be fewer than it was given,
            // so the rest goes out until the image is whole; a write that
            // takes nothing is a failure rather than a silently cut image.
            const image = new Uint8Array(await blob.arrayBuffer());
            for (let offset = 0; offset < image.byteLength; ) {
              const written = writeSync(1, image, offset, image.byteLength - offset);
              if (written === 0) throw new Error(`stdout accepted none of the remaining ${image.byteLength - offset} image bytes`);
              offset += written;
            }
          },
        },
        {
          name: "set",
          use: "set <project> <file>",
          short: "Set the project's background image from a file",
          long:
            "Set the project's background image from a file.\n\n" +
            "The bytes are uploaded through the presigned URL the API prepares,\n" +
            "then finalized, the way the web app's upload runs. The content type\n" +
            "comes from --content-type, or from the file's extension; the server\n" +
            "accepts only the image types it lists and files up to its size\n" +
            "limit. `-` reads the bytes from stdin, which then needs\n" +
            "--content-type.\n\n" +
            "Both arguments are required rather than resolved from the settings,\n" +
            "as `project rm`'s is: a file path cannot double as a project\n" +
            "reference.",
          args: exactArgs(2),
          flags: [
            {
              name: "content-type",
              type: "string" as const,
              usage: "MIME type of the image (default: the file's, from its extension)",
              defaultValue: "",
            },
          ],
          run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
            apiKey(app);
            const ref = args[0]!;
            const source = args[1]!;
            const named = sourceName(source);
            // What --content-type asked for, "" included: an empty one is
            // refused the same as none below. stdin has no file to take a
            // type from, so for it the flag is the only source — checked
            // before the read, which on a terminal would wait for EOF before
            // reporting the missing flag.
            const contentTypeFlag = changed.has("content-type") ? String(flags["content-type"] ?? "").trim() : undefined;
            if (source === "-" && (contentTypeFlag === undefined || contentTypeFlag === "")) {
              throw new Error(`${named} gives no usable content type; pass --content-type`);
            }
            let bytes: Uint8Array;
            let fileType = "";
            try {
              if (source === "-") {
                bytes = await Bun.stdin.bytes();
              } else {
                const file = Bun.file(source);
                fileType = file.type;
                bytes = await file.bytes();
              }
            } catch (e) {
              throw new Error(`reading ${named}: ${e instanceof Error ? e.message : String(e)}`);
            }
            // Bun.file().type answers application/octet-stream when the name
            // says nothing, which is no image type the server takes, so it
            // counts as no content type here; stdin has no file to ask and is
            // "" outright. --content-type wins either way, and an empty one is
            // refused the same as none.
            const detected = fileType === "application/octet-stream" ? "" : fileType;
            const contentType = contentTypeFlag ?? detected;
            if (contentType === "") throw new Error(`${named} gives no usable content type; pass --content-type`);
            const done = await withProject(ref, async (id) => ({
              project: id,
              ...(await setProjectBackground(id, contentType, bytes).catch(
                refused("setting a project background", "update", () => projectWorkspace(id)),
              )),
            }));
            app.out.human(`set the background of ${done.project} from ${named} (${contentType}, ${bytes.byteLength} bytes)`);
            app.out.human(`  ${done.url}`);
            app.out.data({ project: done.project, url: done.url, version: done.version, contentType, size: bytes.byteLength });
          },
        },
        {
          name: "rm",
          aliases: ["delete"],
          use: "rm <project>",
          short: "Remove the project's background image",
          long:
            "Remove the project's background image.\n\n" +
            "The project keeps everything else; `background set` puts an image\n" +
            "back.\n\n" +
            "The project is named the way `project rm` names it — required rather\n" +
            "than resolved from the settings — and --yes confirms, as every\n" +
            "delete asks.",
          args: exactArgs(1),
          flags: [{ name: "yes", type: "bool" as const, usage: "confirm the removal", defaultValue: "false" }],
          run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
            apiKey(app);
            const found = await withProject(args[0]!, (id) => getProject(id));
            // The image is gone for good — there is no trash to restore it
            // from — so the confirmation is asked for the way every other
            // delete asks for it.
            if (flags.yes !== true) {
              throw new Error(
                `refusing to remove the background of ${found.name}${found.slug === "" ? "" : ` [${found.slug}]`} (${found.id}) without --yes`,
              );
            }
            await deleteProjectBackground(found.id).catch(refused("removing a project background", "update", async () => found.workspaceId));
            app.out.human(`removed the background of ${found.id}  ${found.name}`);
            app.out.data({ project: found.id, backgroundRemoved: true });
          },
        },
      ],
    },
  ],
};

// The server's bare 403 "Insufficient permissions", which is all a refused
// permission check says: it does not name the permission or, for a move,
// which workspace's check refused.
const insufficientPermissions = (e: unknown): boolean =>
  e instanceof KaneoApiError && e.statusCode === 403 && e.messages.includes("Insufficient permissions");

// The caller's role in one workspace's member list, "" when the list cannot
// be read or does not name them.
const roleIn = async (me: User, workspaceId: string): Promise<string> =>
  (await listMembers(workspaceId)).find((m) => m.id === me.id)?.role ?? "";

// What the server's bare 403 "Insufficient permissions" means for a project
// route: which permission it checks (Kaneo 2.32.0's requireWorkspacePermission),
// which roles have it by default (packages/permissions), and the caller's own
// role in the workspace, read from /user/me and the member list. undefined for
// any other failure. The role is best effort: the 403 is the answer, so a role
// that cannot be read is left out rather than replacing it.
const permissionHint = async (
  e: unknown,
  doing: string,
  permission: "update" | "delete" | "update and delete",
  workspaceOf: () => Promise<string>,
): Promise<string | undefined> => {
  if (!insufficientPermissions(e)) return undefined;
  const workspaceId = await workspaceOf().catch(() => "");
  const role =
    workspaceId === ""
      ? ""
      : // One after the other, so the requests go out in the same order every run.
        await (async () => {
          const me = await currentUser();
          return roleIn(me, workspaceId);
        })().catch(() => "");
  const yours = role === "" ? "" : `; your role there is ${role}`;
  const where = workspaceId === "" ? "kaneo workspace members" : `kaneo workspace members -w ${shellWord(workspaceId)}`;
  const noun = permission.includes(" and ") ? "permissions" : "permission";
  return `${doing} needs the project ${permission} ${noun} in the workspace, which the owner and admin roles have unless the workspace's roles were changed${yours}; \`${where}\` lists each member's role`;
};

// The same refusal for a move, which the server can answer for either side:
// the source needs the project's update and delete permissions, the
// destination project creation and workspace settings management, and the
// 403 does not say which side refused. Both are named, with the caller's
// role in each workspace where it can be read — the destination's id is
// already resolved, the source's is read back off the project.
const movePermissionHint = async (
  e: unknown,
  projectId: string,
  destinationId: string,
): Promise<string | undefined> => {
  if (!insufficientPermissions(e)) return undefined;
  const sourceId = await projectWorkspace(projectId).catch(() => "");
  const me = await currentUser().catch(() => undefined);
  const role = async (workspaceId: string): Promise<string> =>
    me === undefined || workspaceId === "" ? "" : await roleIn(me, workspaceId).catch(() => "");
  const inSource = await role(sourceId);
  const inDestination = sourceId === destinationId ? inSource : await role(destinationId);
  const yours =
    inSource !== "" && inDestination !== ""
      ? `; your role in the source is ${inSource} and in the destination is ${inDestination}`
      : inSource !== ""
        ? `; your role in the source is ${inSource}`
        : inDestination !== ""
          ? `; your role in the destination is ${inDestination}`
          : "";
  const members = (workspaceId: string) => `kaneo workspace members -w ${shellWord(workspaceId)}`;
  const where =
    sourceId !== "" && sourceId !== destinationId
      ? `\`${members(sourceId)}\` and \`${members(destinationId)}\` list each member's role`
      : `\`${members(destinationId)}\` lists each member's role`;
  return `moving a project needs the project update and delete permissions in the source workspace, and project creation plus workspace settings management in the destination, which the owner and admin roles have unless the workspace's roles were changed${yours}; ${where}`;
};

const refused =
  (doing: string, permission: "update" | "delete" | "update and delete", workspaceOf: () => Promise<string>) =>
  async (e: unknown): Promise<never> => {
    const why = await permissionHint(e, doing, permission, workspaceOf);
    if (why === undefined) throw e;
    throw new Error(`${(e as Error).message}: ${why}`);
  };

// A move's refusal can come from either workspace, so its hint is its own.
const moveRefused =
  (projectId: string, destinationId: string) =>
  async (e: unknown): Promise<never> => {
    const why = await movePermissionHint(e, projectId, destinationId);
    if (why === undefined) throw e;
    throw new Error(`${(e as Error).message}: ${why}`);
  };

const projectWorkspace = async (projectId: string): Promise<string> => (await getProject(projectId)).workspaceId;

// The project a reference names, if any.
//
// Matched the way every other reference to a project is matched, so that this
// command answers to the same words `--project` does: an id exactly, then a slug
// exactly and case-folded, then a name exactly and case-folded. The keys are
// tried in turn rather than together, so a value that is an id and also spells
// somebody's slug is still read as the id it is. A workspace's projects are not
// unique by slug or name, so whichever key matched more than one is refused with
// their ids rather than resolved to the first of them.
const findProject = (projects: Project[], ref: string): Project | undefined => {
  const wanted = ref.trim();
  const found = firstMatch(projects, wanted, (project) => project.id, [
    (project) => project.slug,
    (project) => project.name,
  ]);
  if (found.length > 1) {
    throw new Error(
      `${found.length} projects match ${JSON.stringify(wanted)}; name one by its id (${found.map((project) => project.id).join(", ")})`,
    );
  }
  return found[0];
};

// The order a list of references describes, or a refusal naming every way the
// list falls short.
//
// Raised before anything is written, because the server keeps the rank of a
// project left out of the payload: naming half of them would reorder those half
// within the slots around the one left behind, which is not the order anybody
// typed.
//
// A reference is matched against the projects that are not archived first: an
// archived project may share a name or a slug with an active one, and only when
// nothing active answers to the word is it looked for among the archived, to say
// why it was refused.
const newProjectOrder = (projects: Project[], refs: string[]): Project[] => {
  const active = projects.filter((project) => !archived(project));
  const shelved = projects.filter((project) => archived(project));
  const ordered: Project[] = [];
  const taken = new Set<string>();
  const unknown: string[] = [];
  const kept: string[] = [];
  const repeated: string[] = [];
  for (const ref of refs) {
    const wanted = ref.trim();
    const found = findProject(active, wanted);
    if (found === undefined) {
      const isShelved = firstMatch(shelved, wanted, (project) => project.id, [(project) => project.slug, (project) => project.name]).length > 0;
      (isShelved ? kept : unknown).push(wanted);
    } else if (taken.has(found.id)) repeated.push(wanted);
    else {
      taken.add(found.id);
      ordered.push(found);
    }
  }
  // An archived project is not in the order at all, so it is not missing from it.
  const missing = active.filter((project) => !taken.has(project.id)).map((project) => slugOr(project.slug, project.id));
  const wrong = [
    ...(unknown.length === 0 ? [] : [`unknown: ${unknown.join(", ")}`]),
    ...(kept.length === 0 ? [] : [`archived: ${kept.join(", ")} (it keeps its place)`]),
    ...(repeated.length === 0 ? [] : [`repeated: ${repeated.join(", ")}`]),
    ...(missing.length === 0 ? [] : [`missing: ${missing.join(", ")}`]),
  ];
  if (wrong.length > 0) {
    throw new Error(`every project in this workspace that is not archived has to be named exactly once: ${wrong.join("; ")}`);
  }
  return ordered;
};

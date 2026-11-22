import { apiKey, project, type App } from "./app";
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  listFieldFilterValues,
  listProjectFieldValues,
  reorderCustomFields,
  type CustomField,
  type CustomFieldFilter,
  type CustomFieldValue,
} from "../api/kaneo";
import { exactArgs, maximumArgs, minimumArgs, noArgs, type FlagValues } from "./args";
import { allowArchivedFlag, guardProject, withProject, writeAccess } from "./lookup";
import { shellWord } from "../output/output";

// The field a reference names, if any.
//
// A reference is a field id or a field name. The id is what the routes address
// the field by; a name is what a person sees. The server keeps no uniqueness on
// names, so a name two fields share is refused rather than guessed, the way a
// column name is.
const findField = (fields: CustomField[], ref: string): CustomField | undefined => {
  const wanted = ref.trim();
  const byId = fields.find((f) => f.id === wanted);
  if (byId !== undefined) return byId;
  const named = fields.filter((f) => f.name === wanted);
  if (named.length > 1) {
    throw new Error(`${named.length} fields are named ${JSON.stringify(wanted)}; name one by its id (${named.map((f) => f.id).join(", ")})`);
  }
  return named[0];
};

// The same, refused rather than undefined when nothing matches, so a caller
// that cannot go on does not have to say what is missing.
//
// Exported because `task field` names a field of the task's project the same
// way this group does, and a second copy of these rules would be a second
// answer to the same reference.
export const resolveField = async (projectId: string, ref: string, where = "in this project"): Promise<CustomField> => {
  const found = findField(await listCustomFields(projectId), ref);
  if (found !== undefined) return found;
  throw new Error(`no field ${JSON.stringify(ref.trim())} ${where}; \`kaneo field ls -p ${shellWord(projectId)}\` lists them`);
};

// The same, for the filter-values listing, whose rows carry id and name but
// are not definitions.
const pickFilter = (filters: CustomFieldFilter[], ref: string, where = "in this project; `kaneo field ls` lists them"): CustomFieldFilter => {
  const wanted = ref.trim();
  const byId = filters.find((f) => f.fieldId === wanted);
  if (byId !== undefined) return byId;
  const named = filters.filter((f) => f.fieldName === wanted);
  if (named.length > 1) {
    throw new Error(`${named.length} fields are named ${JSON.stringify(wanted)}; name one by its id (${named.map((f) => f.fieldId).join(", ")})`);
  }
  const found = named[0];
  if (found === undefined) throw new Error(`no field ${JSON.stringify(wanted)} ${where}`);
  return found;
};

// One field as a person reads it: the id the routes take, the name, the type,
// and what a choice field offers.
const fieldLine = (field: CustomField): string => {
  const parts = [field.id, field.name, `(${field.type}${field.required ? ", required" : ""})`];
  if (Array.isArray(field.options) && field.options.every((o) => typeof o === "string")) {
    parts.push(`[${(field.options as string[]).join(", ")}]`);
  }
  return parts.join("  ");
};

// One stored value as a person reads it.
const valueLine = (value: CustomFieldValue): string =>
  [value.fieldName, value.fieldType, value.value ?? "(unset)"].join("  ");

// The order a list of references describes, or a refusal naming every way the
// list falls short — the same rule `column reorder` keeps, since the server
// moves only the fields it is sent.
const newOrder = (fields: CustomField[], refs: string[]): CustomField[] => {
  const ordered: CustomField[] = [];
  const taken = new Set<string>();
  const unknown: string[] = [];
  const repeated: string[] = [];
  for (const ref of refs) {
    const wanted = ref.trim();
    const found = findField(fields, wanted);
    if (found === undefined) unknown.push(wanted);
    else if (taken.has(found.id)) repeated.push(wanted);
    else {
      taken.add(found.id);
      ordered.push(found);
    }
  }
  const missing = fields.filter((f) => !taken.has(f.id)).map((f) => f.name);
  const wrong = [
    ...(unknown.length === 0 ? [] : [`unknown: ${unknown.join(", ")}`]),
    ...(repeated.length === 0 ? [] : [`repeated: ${repeated.join(", ")}`]),
    ...(missing.length === 0 ? [] : [`missing: ${missing.join(", ")}`]),
  ];
  if (wrong.length > 0) {
    throw new Error(`every field of this project has to be named exactly once: ${wrong.join("; ")}`);
  }
  return ordered;
};

export const fieldCommand = {
  name: "field",
  aliases: ["fld"],
  short: "Work with a project's custom fields",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List the resolved project's custom fields, in order",
      args: noArgs("kaneo field list"),
      run: async ({ app }: { app: App }) => {
        apiKey(app);
        const fields = await withProject(project(app), async (id) => {
          await guardProject(id);
          return listCustomFields(id);
        });
        for (const field of fields) app.out.human(fieldLine(field));
        app.out.data(fields);
      },
    },
    {
      name: "add",
      use: "add <name...>",
      short: "Add a custom field to the resolved project",
      long:
        "Add a custom field to the resolved project.\n\n" +
        "--type is one of text, number, date, dropdown, boolean and multiselect. A\n" +
        "dropdown needs --options and a multiselect needs at least two; the server\n" +
        "checks the rest of the combination (a required field needs a --default, a\n" +
        "default must fit the type) and says what is wrong. A default is filled\n" +
        "into the tasks that have no value yet; a multiselect default and a\n" +
        "multiselect value are a JSON array of options, as the web app writes them.",
      args: minimumArgs(1),
      flags: [
        {
          name: "type",
          type: "string" as const,
          usage: "field type: text, number, date, dropdown, boolean or multiselect",
          defaultValue: "",
        },
        { name: "required", type: "bool" as const, usage: "every task must have a value", defaultValue: "false" },
        { name: "default", type: "string" as const, usage: "value new tasks start with", defaultValue: "" },
        {
          name: "options",
          type: "string" as const,
          usage: "the choices of a dropdown or multiselect field, comma-separated",
          defaultValue: "",
        },
        allowArchivedFlag,
      ],
      run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        const name = args.join(" ").trim();
        if (name === "") throw new Error("a field name cannot be blank");
        const type = String(flags.type ?? "").trim();
        if (!changed.has("type") || type === "") {
          throw new Error("field add needs --type: text, number, date, dropdown, boolean or multiselect");
        }
        apiKey(app);
        const options = changed.has("options")
          ? String(flags.options ?? "")
              .split(",")
              .map((o) => o.trim())
              .filter((o) => o !== "")
          : undefined;
        const defaultValue = changed.has("default") ? String(flags.default ?? "") : undefined;
        const field = await withProject(project(app), async (id) => {
          await guardProject(id, writeAccess(flags));
          return createCustomField(id, {
            name,
            type,
            required: flags.required === true,
            ...(defaultValue === undefined || defaultValue.trim() === "" ? {} : { defaultValue }),
            ...(options === undefined ? {} : { options }),
          });
        });
        app.out.human(`created ${fieldLine(field)}`);
        app.out.data(field);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      use: "rm <field>",
      short: "Delete a custom field and the values tasks hold for it",
      args: exactArgs(1),
      flags: [
        { name: "yes", type: "bool" as const, usage: "confirm the deletion", defaultValue: "false" },
        allowArchivedFlag,
      ],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const field = await withProject(project(app), async (id) => {
          await guardProject(id, writeAccess(flags));
          return resolveField(id, args[0]!);
        });
        // The values every task holds for the field go with it, and there is
        // no undo: they are deleted, not unset.
        if (flags.yes !== true) {
          throw new Error(`refusing to delete field ${JSON.stringify(field.name)} without --yes; the values tasks hold for it are deleted too`);
        }
        const deleted = await deleteCustomField(field.id);
        app.out.human(`deleted field ${deleted.name}`);
        app.out.data(deleted);
      },
    },
    {
      name: "reorder",
      use: "reorder <field>...",
      short: "Put the project's custom fields in a new order",
      long:
        "Put the project's custom fields in a new order.\n\n" +
        "Every field has to be named exactly once, by id or name: the server only\n" +
        "moves the fields it is sent, so a field left out would keep its old\n" +
        "position and share it with whichever field took that place.",
      args: minimumArgs(1),
      flags: [allowArchivedFlag],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const { projectId, fields } = await withProject(project(app), async (id) => {
          await guardProject(id, writeAccess(flags));
          return { projectId: id, fields: await listCustomFields(id) };
        });
        const order = newOrder(fields, args);
        const reordered = await reorderCustomFields(
          projectId,
          order.map((field) => field.id),
        );
        for (const field of reordered) app.out.human(fieldLine(field));
        app.out.data(reordered);
      },
    },
    {
      name: "values",
      use: "values [field]",
      short: "List the values tasks hold, or the values one field can take",
      long:
        "List the values tasks hold, or the values one field can take.\n\n" +
        "Without a field, every stored value in the project is listed, across all\n" +
        "its tasks. With one — a field id or name — the distinct values tasks\n" +
        "actually use for it are listed, which is what a filter on the field can\n" +
        "offer. Only fields somebody set a value on appear either way.",
      args: maximumArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        if (args[0] === undefined) {
          const values = await withProject(project(app), async (id) => {
            await guardProject(id);
            return listProjectFieldValues(id);
          });
          const ordered = [...values].sort((a, b) => a.fieldPosition - b.fieldPosition || a.taskId.localeCompare(b.taskId));
          for (const value of ordered) app.out.human(`${value.taskId}  ${valueLine(value)}`);
          app.out.data(ordered);
          return;
        }
        const filter = await withProject(project(app), async (id) => {
          await guardProject(id);
          return pickFilter(await listFieldFilterValues(id), args[0]!);
        });
        for (const value of filter.values) app.out.human(value);
        app.out.data(filter);
      },
    },
  ],
};

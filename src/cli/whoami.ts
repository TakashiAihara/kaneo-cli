import { existsSync, statSync } from "node:fs";
import { apiKey, type App } from "./app";
import { authSession, currentUser, deleteAvatar, listWorkspaces, uploadAvatar, type User, type Workspace } from "../api/kaneo";
import { KaneoApiError, normalizeBaseUrl } from "../api/http";
import { uploadUserAvatarBodyDataMax } from "../api/gen/model";
import { exactArgs, noArgs, type Command, type RunContext } from "./args";

type Report = { api_url: string; user: User; workspaces: Workspace[] };

// The image types the avatar route takes, by file extension. The server's own
// list is png, jpeg and webp; a file named anything else is refused here rather
// than sent for a 400.
const AVATAR_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// Verifies the credential, then says whose it is.
//
// It lists workspaces rather than calling /auth/get-session for the check
// itself: session data is what `whoami session` reports, not what proves the
// key — a call that fails is the proof. /user/me comes second, so a key that
// is refused is reported by the listing, and a server older than v2.28.0, which
// has no /user/me, is reported as that after the key was accepted.
export const whoamiCommand: Command<App> = {
  name: "whoami",
  short: "Verify the configured API key and show whose it is and what it can reach",
  args: (args: string[]) => {
    const first = args[0];
    if (first !== undefined) {
      throw new Error(`unknown command ${JSON.stringify(first)} for "kaneo whoami"`);
    }
  },
  children: [
    {
      name: "session",
      short: "Show the session the credential resolves to",
      long:
        "Show the better-auth session the configured credential resolves to.\n\n" +
        "The session's token is a credential in its own right and is not shown.\n" +
        "An API key that resolves to no session answers null.",
      args: noArgs("kaneo whoami session"),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const session = await authSession();
        if (session === null) {
          app.out.human("no session");
          app.out.data(null);
          return;
        }
        const who = [session.user.name, session.user.email === "" ? "" : `<${session.user.email}>`]
          .filter((part) => part !== "")
          .join(" ");
        app.out.human(`session    ${session.session.id}`);
        app.out.human(`user       ${who === "" ? session.user.id : `${who} (${session.user.id})`}`);
        app.out.human(`created    ${session.session.createdAt}`);
        app.out.human(`expires    ${session.session.expiresAt}`);
        if (session.session.ipAddress !== null) app.out.human(`ip         ${session.session.ipAddress}`);
        if (session.session.userAgent !== null) app.out.human(`agent      ${session.session.userAgent}`);
        app.out.data(session);
      },
    },
    {
      name: "avatar",
      short: "Manage your own avatar image",
      children: [
        {
          name: "set",
          use: "set <file>",
          short: "Upload an image as your avatar",
          long:
            "Upload a PNG, JPEG or WebP image as your avatar, replacing any\n" +
            "existing one. The file's type is read off its extension.",
          args: exactArgs(1),
          run: async ({ args, app }: RunContext<App>) => {
            apiKey(app);
            const file = args[0]!;
            const contentType = avatarType(file);
            if (!existsSync(file)) throw new Error(`no such file: ${file}`);
            // The size is checked before the read so a file far over the
            // limit is refused without being held in memory whole; the check
            // after the read stays for a file that grew while it was read.
            if (statSync(file).size > uploadUserAvatarBodyDataMax) {
              throw new Error(`${file} is too large: the server takes at most ${uploadUserAvatarBodyDataMax} base64 characters (~512 KiB of image)`);
            }
            const bytes = await Bun.file(file).bytes();
            if (bytes.byteLength === 0) throw new Error(`${file} is empty`);
            const data = Buffer.from(bytes).toString("base64");
            if (data.length > uploadUserAvatarBodyDataMax) {
              throw new Error(`${file} is too large: the server takes at most ${uploadUserAvatarBodyDataMax} base64 characters (~512 KiB of image)`);
            }
            const avatar = await uploadAvatar(contentType, data);
            app.out.human(`avatar     ${avatar.id}  ${avatar.url}`);
            app.out.data(avatar);
          },
        },
        {
          name: "rm",
          short: "Remove your avatar",
          args: noArgs("kaneo whoami avatar rm"),
          run: async ({ app }: RunContext<App>) => {
            apiKey(app);
            const result = await deleteAvatar();
            app.out.human(result.deleted ? "avatar removed" : "no avatar to remove");
            app.out.data(result);
          },
        },
      ],
    },
  ],
  run: async ({ app }: { app: App }) => {
    apiKey(app);
    const workspaces = await listWorkspaces();
    const user = await currentUser().catch((e: unknown) => {
      // The route's own 404 is "User not found"; any other means the route is
      // not there.
      if (e instanceof KaneoApiError && e.statusCode === 404 && !e.messages.includes("User not found")) {
        throw new Error(`the API key was accepted, but this server has no /user/me to say whose it is (Kaneo before v2.28.0): ${e.message}`);
      }
      throw e;
    });

    // The API root the calls were made against, not the raw setting: the
    // transport appends /api to whatever it is given, and a key check that
    // printed a different URL from the one used would mislead.
    const apiUrl = normalizeBaseUrl(app.cfg.apiUrl);
    app.out.human(`api url    ${apiUrl}`);
    app.out.human("api key    accepted");
    const who = [user.name, user.email === "" ? "" : `<${user.email}>`].filter((part) => part !== "").join(" ");
    app.out.human(`user       ${who === "" ? user.id : `${who} (${user.id})`}`);
    app.out.human(`workspaces ${workspaces.length}`);
    for (const workspace of workspaces) app.out.human(`  ${workspace.id}  ${workspace.name}`);

    const report: Report = { api_url: apiUrl, user, workspaces };
    app.out.data(report);
  },
};

// The content type a file's extension names, or the refusal that lists what
// the route takes.
const avatarType = (file: string): string => {
  const dot = file.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
  // hasOwn, not a plain lookup: ext is whatever followed the dot, and
  // "constructor" or "__proto__" would otherwise read an inherited member
  // and pass the undefined check with a function for a content type.
  const type = Object.hasOwn(AVATAR_TYPES, ext) ? AVATAR_TYPES[ext] : undefined;
  if (type === undefined) {
    throw new Error(`cannot tell the image type of ${file}: use a .png, .jpg, .jpeg or .webp file`);
  }
  return type;
};

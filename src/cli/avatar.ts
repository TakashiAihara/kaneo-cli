import { downloadAvatar } from "../api/kaneo";
import { exactArgs, type RunContext } from "./args";
import type { App } from "./app";
import { emitDownload } from "./download";

export const avatarCommand = {
  name: "avatar",
  short: "Download a user's avatar image",
  children: [
    {
      name: "get",
      use: "get <avatar-id> [--out <file>]",
      short: "Download an avatar",
      long:
        "Download a user's avatar by its avatar id — the id in the avatar URL,\n" +
        "which `kaneo whoami avatar set` reports and which changes whenever the\n" +
        "avatar is replaced. The route is public, so no key is needed.\n\n" +
        "Without --out the bytes go to stdout as they arrived; with it they are\n" +
        "written to the file named.",
      args: exactArgs(1),
      flags: [
        {
          name: "out",
          type: "string" as const,
          usage: "write the bytes to this file instead of stdout",
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, app }: RunContext<App>) => {
        emitDownload(app, String(flags.out ?? ""), await downloadAvatar(args[0]!));
      },
    },
  ],
};

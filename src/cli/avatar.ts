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
        "Without --out the bytes go to stdout as they arrived — they are not\n" +
        "JSON, so --json and --jq are refused there, and so is a terminal:\n" +
        "redirect to a file (`> out.bin`) or pipe it on. With --out they are\n" +
        "written to the file named, and --json then reports the path, size\n" +
        "and content type rather than the bytes.",
      args: exactArgs(1),
      flags: [
        {
          name: "out",
          type: "string" as const,
          usage: "write the bytes to this file instead of stdout",
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        await emitDownload(app, "avatar get", String(flags.out ?? ""), changed, () => downloadAvatar(args[0]!));
      },
    },
  ],
};

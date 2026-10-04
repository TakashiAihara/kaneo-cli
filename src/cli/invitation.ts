import { apiKey, type App } from "./app";
import { getInvitation } from "../api/kaneo";
import { exactArgs } from "./args";

// Looking up an invitation to a workspace by its id. Sending, accepting and
// canceling one are better-auth organization routes this CLI does not call.
//
// Kaneo's list of the user's own pending invitations is left out: v2.29.2
// answers it with an empty list for any API-key request, because it reads the
// email from a login session that an API key does not carry.
export const invitationCommand = {
  name: "invitation",
  aliases: ["inv"],
  short: "Look up invitations to workspaces",
  children: [
    {
      name: "get",
      use: "get <invitation-id>",
      short: "Show one invitation and whether it can still be accepted",
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const details = await getInvitation(args[0]!);
        const i = details.invitation;
        if (i !== null) app.out.human(`${i.id}  ${i.workspaceName}  from ${i.inviterName}  expires ${i.expiresAt}`);
        // An unusable invitation is the server's answer, not a failed call, so it
        // is reported and the command still succeeds.
        if (!details.valid) app.out.human(`not valid: ${details.error ?? "no reason given"}`);
        app.out.data(details);
      },
    },
  ],
};

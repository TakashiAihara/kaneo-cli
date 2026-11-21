import { instanceConfig, instanceStatus } from "../api/kaneo";
import { noArgs, type RunContext } from "./args";
import type { App } from "./app";

// The instance's public face: whether it has been set up yet, and which
// sign-in methods and features it offers. Both routes are served without
// authentication, so neither asks for a key.
export const instanceCommand = {
  name: "instance",
  short: "Read the instance's public status and configuration",
  children: [
    {
      name: "status",
      short: "Show whether the instance has any users and an admin yet",
      args: noArgs("kaneo instance status"),
      run: async ({ app }: RunContext<App>) => {
        const status = await instanceStatus();
        app.out.human(`has users  ${status.hasUsers ? "yes" : "no"}`);
        app.out.human(`has admin  ${status.hasAdmin ? "yes" : "no"}`);
        app.out.data(status);
      },
    },
    {
      name: "config",
      short: "Show the instance's public configuration",
      args: noArgs("kaneo instance config"),
      run: async ({ app }: RunContext<App>) => {
        const config = await instanceConfig();
        // Printed in the order the server sent them: the document names only
        // some of the fields, and a newer server's additions are shown as they
        // arrive rather than left out for not being documented.
        for (const [key, value] of Object.entries(config)) {
          app.out.human(`${key}  ${setting(value)}`);
        }
        app.out.data(config);
      },
    },
  ],
};

const setting = (value: unknown): string => {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

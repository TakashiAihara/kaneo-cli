import { debug } from "./app";
import type { Flag, RunContext } from "./args";

// A failure that must be reported even by a fail-open command.
//
// Fail-open exists so an unreachable server cannot break a session. It is not a
// licence to hide a failure that leaves things inconsistent — a comment written
// to the server with no local record of it, for instance.
export class HardError extends Error {}

// Wraps an error so fail-open will not swallow it.
export const hard = (message: string): Error => new HardError(message);

// Wraps a command so that a failure produces no output and exit 0.
//
// The session commands run from a session-start hook, where a missing board is a
// smaller harm than a broken session. Every other command, board included,
// reports failures normally: hiding an error from someone typing at a prompt
// would be the larger harm.
//
// --strict turns this off, and KANEO_DEBUG=1 prints the swallowed reason. The
// flag is named the same on every fail-open command, so it is read by name here
// rather than passed through.
export const failOpen =
  <A>(run: (ctx: RunContext<A>) => Promise<void>) =>
  async (ctx: RunContext<A>): Promise<void> => {
    try {
      await run(ctx);
    } catch (e) {
      if (ctx.flags.strict === true) throw e;
      // A failure that already changed something elsewhere has to surface:
      // staying quiet would leave the caller believing a half-done operation
      // succeeded.
      if (e instanceof HardError) throw e;
      debug(e instanceof Error ? e.message : String(e));
    }
  };

export const strictFlag: Flag = {
  name: "strict",
  type: "bool",
  usage:
    "report failures instead of exiting quietly; this command is otherwise silent on error so it is safe to call from a hook",
  defaultValue: "false",
};
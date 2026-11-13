import { copilotCliProgramPath } from "../../src/copilot-client.ts";

/**
 * Why the Copilot CLI program (the platform package of `@github/copilot`,
 * an optional dependency) can't run here, or null when it can. Tests of the
 * program skip with this reason: `ctx.skip(Boolean(missing), missing)`.
 */
export function cliProgramMissing() {
    try {
        copilotCliProgramPath();
        return null;
    } catch (error) {
        return String(error?.message ?? error);
    }
}

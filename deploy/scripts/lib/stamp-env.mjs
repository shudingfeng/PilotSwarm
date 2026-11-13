// The env map of one local env, as deploy.mjs composes it, for deploy.mjs and
// the operator commands beside it (rotate-ca.mjs): the env file with its
// process.env overrides (common.mjs, loadEnv), the Bicep outputs of earlier
// deploys from the outputs cache, already under the alias map's names, and
// the values composed from them (compose-env.mjs).

import { loadEnv, log } from "./common.mjs";
import { loadCache as loadBicepOutputsCache } from "./bicep-outputs-cache.mjs";
import { composeDerivedEnv } from "./compose-env.mjs";

export function loadStampEnv(envName, { region } = {}) {
  const { env, sources } = loadEnv(envName);
  if (region) env.LOCATION = region;
  log("info", `Loaded env: ${sources.local}`);
  // Cached outputs never override the env file or a CLI value; `--clean` or
  // deleting deploy/.tmp/<env>/bicep-outputs.cache.json busts the cache.
  loadBicepOutputsCache(envName, env);
  // DATABASE_URL and the other composed values, from the cached outputs. A
  // fresh `all` run composes them again after each bicep stage.
  composeDerivedEnv(env);
  return env;
}

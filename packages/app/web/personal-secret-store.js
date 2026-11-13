/**
 * External personal secrets: the portal's composition hook.
 *
 * PILOTSWARM_PERSONAL_SECRET_STORE_MODULE names a module, by file path or
 * package name, that supplies the deployment's PersonalSecretStore (`put`,
 * `delete`, `describe`; see pilotswarm-sdk). Its `createPersonalSecretStore`
 * export, else its default export, is the store or a function that returns
 * it, possibly asynchronously; the function gets `{ env }`. A module whose
 * own exports are the three methods is a store too.
 *
 * With PILOTSWARM_PERSONAL_SECRETS=external the portal does not start
 * without a store. With database mode a configured store is still loaded,
 * so deleting a provider whose key it holds also deletes the key.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertPersonalSecretStore, personalSecretsMode } from "pilotswarm-sdk";

export const PERSONAL_SECRET_STORE_MODULE_SETTING = "PILOTSWARM_PERSONAL_SECRET_STORE_MODULE";

function moduleSpecifier(configured) {
    const isPath = path.isAbsolute(configured) || configured.startsWith(".")
        || (/[\\/]/.test(configured) && !configured.startsWith("@"));
    return isPath ? pathToFileURL(path.resolve(configured)).href : configured;
}

export async function loadPersonalSecretStore(env = process.env, { importModule = (specifier) => import(specifier) } = {}) {
    const mode = personalSecretsMode(env);
    const configured = String(env[PERSONAL_SECRET_STORE_MODULE_SETTING] ?? "").trim();
    if (!configured) {
        if (mode === "external") {
            throw new Error(
                `PILOTSWARM_PERSONAL_SECRETS=external needs ${PERSONAL_SECRET_STORE_MODULE_SETTING} `
                + "to name the module that stores personal tokens.",
            );
        }
        return null;
    }
    const loaded = await importModule(moduleSpecifier(configured));
    const exported = loaded?.createPersonalSecretStore ?? loaded?.default ?? loaded;
    const store = typeof exported === "function" ? await exported({ env }) : exported;
    return assertPersonalSecretStore(store, `${PERSONAL_SECRET_STORE_MODULE_SETTING} (${configured})`);
}

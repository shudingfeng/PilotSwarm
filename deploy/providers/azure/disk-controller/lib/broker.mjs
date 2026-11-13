// The credential broker. A worker VM gets a session's credentials only from
// here, and only while the session's root holds a live drive lease of the
// VM's owner:
//
//   POST /v1/credentials/model  the owner's personal GitHub token from the
//                               personal vault, by the secret name and
//                               version the provider row's reference names
//   POST /v1/credentials/work   the work's per-work credential, which the
//                               dispatcher set; opaque to PilotSwarm
//
// The answers follow the worker's personal credential resolver contract:
// `ok` with the value, `refused` (the turn fails and is not retried), `busy`
// (the session waits) or `unavailable` (the turn fails and is retried).
// Every answer is audited with its reason, never with the value, and no
// value is kept anywhere but in the answer.
import { HttpError } from "./http.mjs";
import { busy, isGuid, isId, leaseBusy, leaseOfRoot } from "./model.mjs";
import { graceEnd, inGrace, isServing } from "./fleet.mjs";

const SECRET_VERSION = /^[0-9a-f]{32}$/i;

/** The personal secret names the Key Vault personal secret store writes for an owner: ghcp-<owner>-<32 hex>. */
export function ownerSecretPattern(ownerOid) {
  return new RegExp(`^ghcp-${ownerOid.replace(/[^0-9a-f-]/gi, "")}-[0-9a-f]{32}$`, "i");
}

const refused = (code, message) => ({ status: "refused", code, message });

function startingAnswer(ctl) {
  return { status: "busy", ...busy("CONTROLLER_STARTING", Math.max(5_000, graceEnd(ctl) - ctl.now()), "The disk controller is starting.") };
}

/** The checks both routes share: an active VM of the pool, a live lease of the root, and the VM bound to the lease's owner. */
function leaseForVm(ctl, vm, rootSessionId) {
  const record = ctl.state.get("vm", vm.name);
  if (!isServing(record)) return { answer: refused("VM_NOT_ACTIVE", "This VM is not an active, non-draining worker of the pool.") };
  const disk = leaseOfRoot(ctl.state.all("disk"), rootSessionId);
  if (!disk) return { answer: refused("NO_DRIVE_LEASE", "This session's root holds no Dev Drive.") };
  const refusal = leaseBusy(disk);
  if (refusal) return { answer: { status: "busy", ...busy(refusal.reason, refusal.retryAfterMs, refusal.message) } };
  if (record.ownerOid !== disk.lease.ownerOid) return { answer: refused("VM_NOT_BOUND_TO_OWNER", "This VM is not bound to the session's owner.") };
  return { record, disk };
}

/** POST /v1/credentials/model { sessionId, rootSessionId, provider, secretName, secretVersion }. */
export async function releaseModelToken(ctl, vm, body) {
  for (const field of ["sessionId", "rootSessionId", "provider"]) {
    if (!isId(body?.[field])) throw new HttpError(400, "BAD_REQUEST", `${field} is required.`);
  }
  if (typeof body.secretName !== "string" || !/^[0-9A-Za-z-]{1,127}$/.test(body.secretName)) {
    throw new HttpError(400, "BAD_REQUEST", "secretName must be a Key Vault secret name.");
  }
  if (typeof body.secretVersion !== "string" || !SECRET_VERSION.test(body.secretVersion)) {
    throw new HttpError(400, "BAD_REQUEST", "secretVersion must be a Key Vault secret version.");
  }
  const audit = {
    vm: vm.name,
    session: body.sessionId,
    root: body.rootSessionId,
    provider: body.provider,
    secretName: body.secretName,
    secretVersion: body.secretVersion,
  };
  const finish = (answer, status = 200, owner = null) => {
    ctl.log.audit("credential.model", { ...audit, owner, outcome: answer.status, code: answer.code ?? answer.reason ?? null });
    return { status, body: answer };
  };
  if (!ctl.secrets) return finish({ status: "unavailable", message: "No personal secret vault is configured." }, 503);
  if (inGrace(ctl)) return finish(startingAnswer(ctl));
  const checked = leaseForVm(ctl, vm, body.rootSessionId);
  if (checked.answer) return finish(checked.answer);
  const owner = checked.disk.lease.ownerOid;
  if (!ownerSecretPattern(owner).test(body.secretName)) {
    return finish(refused("SECRET_NOT_OWNERS", "The secret is not the session owner's."), 200, owner);
  }
  let secret;
  try {
    secret = await ctl.secrets.getSecret(body.secretName, { version: body.secretVersion });
  } catch (err) {
    if (err?.statusCode === 404) return finish(refused("SECRET_NOT_FOUND", "The secret version does not exist."), 200, owner);
    ctl.log.error("credential.vault-failed", { ...audit, error: err?.message ?? String(err), statusCode: err?.statusCode ?? null });
    return finish({ status: "unavailable", message: "The personal vault could not be read." }, 503, owner);
  }
  const properties = secret?.properties ?? {};
  if (String(properties.tags?.ownerOid ?? "").toLowerCase() !== owner) {
    return finish(refused("SECRET_TAG_MISMATCH", "The secret is tagged with another owner."), 200, owner);
  }
  if (properties.enabled === false) return finish(refused("SECRET_DISABLED", "The secret is disabled."), 200, owner);
  const expiresOn = properties.expiresOn instanceof Date ? properties.expiresOn.getTime() : null;
  if (expiresOn !== null && expiresOn <= ctl.now()) return finish(refused("SECRET_EXPIRED", "The secret has expired."), 200, owner);
  if (typeof secret.value !== "string" || !secret.value) return finish(refused("SECRET_EMPTY", "The secret has no value."), 200, owner);
  return finish({ status: "ok", token: secret.value }, 200, owner);
}

/** POST /v1/credentials/work { rootSessionId }: only to the VM that holds the work's drive. */
export async function releaseWorkCredential(ctl, vm, body) {
  if (!isId(body?.rootSessionId)) throw new HttpError(400, "BAD_REQUEST", "rootSessionId is required.");
  const finish = (answer, disk = null) => {
    ctl.log.audit("credential.work", {
      vm: vm.name,
      root: body.rootSessionId,
      workId: disk?.lease?.workId ?? null,
      owner: disk?.lease?.ownerOid ?? null,
      outcome: answer.status,
      code: answer.code ?? answer.reason ?? null,
    });
    return answer;
  };
  if (inGrace(ctl)) return finish(startingAnswer(ctl));
  const checked = leaseForVm(ctl, vm, body.rootSessionId);
  if (checked.answer) return finish(checked.answer);
  const { disk } = checked;
  if (disk.attach?.vmName !== vm.name || disk.attach.state !== "attached") {
    return finish(refused("DRIVE_NOT_ON_VM", "This VM does not hold the work's drive."), disk);
  }
  if (!disk.lease.credential) return finish(refused("NO_CREDENTIAL", "The work has no per-work credential."), disk);
  return finish({ status: "ok", credential: disk.lease.credential }, disk);
}

/**
 * GET /disk-pool/v1/owners/{ownerOid}/model-credential: { present, expiresOn,
 * enabled } of the owner's live personal secret, from its attributes only.
 * Soft-deleted secrets are not listed.
 */
export async function modelCredentialStatus(ctl, ownerText) {
  if (!isGuid(ownerText)) throw new HttpError(400, "BAD_REQUEST", "The owner must be an object ID.");
  if (!ctl.secrets) throw new HttpError(503, "UNAVAILABLE", "No personal secret vault is configured.");
  const owner = ownerText.toLowerCase();
  const pattern = ownerSecretPattern(owner);
  let latest = null;
  try {
    for await (const properties of ctl.secrets.listPropertiesOfSecrets()) {
      if (!pattern.test(String(properties.name ?? ""))) continue;
      if (String(properties.tags?.ownerOid ?? "").toLowerCase() !== owner) continue;
      const stamp = (properties.updatedOn ?? properties.createdOn ?? new Date(0)).getTime();
      if (!latest || stamp > latest.stamp) latest = { stamp, properties };
    }
  } catch (err) {
    ctl.log.error("credential.vault-failed", { owner, error: err?.message ?? String(err), statusCode: err?.statusCode ?? null });
    throw new HttpError(503, "UNAVAILABLE", "The personal vault could not be read.");
  }
  if (!latest) return { present: false, expiresOn: null, enabled: false };
  const { properties } = latest;
  return {
    present: true,
    expiresOn: properties.expiresOn instanceof Date ? properties.expiresOn.toISOString() : null,
    enabled: properties.enabled !== false,
  };
}

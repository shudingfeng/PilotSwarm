// One JSON line per event on stdout, which the cluster's log collection
// carries to Log Analytics. `audit` records every credential release, every
// dispatcher call and admission, and every attach, detach, release request,
// fencing and quarantine; `alert` marks the records the deployment's alert
// rules watch.
// Nothing here ever carries a credential: callers pass names and outcomes,
// and fields with a secret's usual names are dropped as a second guard.
const SECRET_FIELDS = new Set(["credential", "token", "value", "password", "authorization", "secret"]);

function clean(fields) {
  const out = {};
  for (const [key, field] of Object.entries(fields ?? {})) {
    if (SECRET_FIELDS.has(key.toLowerCase()) || field === undefined) continue;
    out[key] = field instanceof Error ? field.message : field;
  }
  return out;
}

export function createLogger({ write = (line) => process.stdout.write(`${line}\n`), now = () => Date.now() } = {}) {
  const emit = (level, event, fields) => {
    write(JSON.stringify({ time: new Date(now()).toISOString(), level, event, ...clean(fields) }));
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    audit: (event, fields) => emit("audit", event, fields),
    alert: (event, fields) => emit("alert", event, fields),
  };
}

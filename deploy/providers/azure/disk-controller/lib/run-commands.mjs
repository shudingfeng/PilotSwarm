// Run Command scripts the controller runs on worker VMs as Managed Run
// Commands. The scripts themselves ship with the worker image; these name
// them. PS_DISK_CONTROLLER_VM_SCRIPTS_DIR sets their folder.

/** Drains the worker and stops its service; the controller then deletes the VM, or keeps it stopped during an upgrade freeze. */
export function drainScript(dir) {
  return `& '${dir}\\Drain-And-StopWorker.ps1'`;
}

/** Starts the worker service again after an upgrade freeze. */
export const START_WORKER_SCRIPT = "Start-Service -Name PilotSwarmWorker";

/** Refreshes the repositories and caches on the snapshot refresh VM's drive (Q:). */
export function refreshScript(dir) {
  return `& '${dir}\\Seed-WorkerReposDisk.ps1' -Refresh`;
}

/**
 * Verifies the refreshed drive. Its last output line is one JSON object:
 * { "verified": true|false, "manifestSha256": "<hex>", "checks": { ... } }.
 */
export function verifyScript(dir) {
  return `& '${dir}\\Seed-WorkerReposDisk.ps1' -Verify`;
}

export const TERMINAL_RUN_STATES = new Set(["Succeeded", "Failed", "TimedOut", "Canceled"]);

/** The last JSON object line of a run command's output, or null. */
export function lastJsonLine(output) {
  const lines = String(output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].startsWith("{")) continue;
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Not the result line.
    }
  }
  return null;
}

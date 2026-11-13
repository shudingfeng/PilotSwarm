// The coordination host's staging is the Azure provider's
// (deploy/providers/azure/lib/coordination-host.mjs): re-exported here for the
// modules and tests that import it from deploy/scripts.
export * from "../../providers/azure/lib/coordination-host.mjs";

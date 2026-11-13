# Entra roles for application identities

`WorkerRoles.ps1` holds the functions behind the roles that applications can
hold on the portal's Entra app: `deploy/scripts/auth/Setup-PortalAuth.ps1
-WorkerRoles` adds the `worker`, `deployer` and `coordinator` roles, lets
applications hold `user` and switches the app to v2.0 access tokens, merging
the roles into the app's existing ones so that those keep their IDs; and
`Set-PortalAuthAssignments.ps1` looks a role's principals up by the member
types the role allows.

The file only defines functions; nothing runs it on its own. The scripts
dot-source it by its path from their own folder: `Setup-PortalAuth.ps1` only
with `-WorkerRoles`, so without the switch it does exactly what it did before,
and `Set-PortalAuthAssignments.ps1` always. Dot-sourced, the functions run
with the script's `$ErrorActionPreference` and call the script's own functions
(`Invoke-GraphPatch`, `Build-AppRolesJson`, `Resolve-Principal`).

See [`deploy/scripts/auth/README.md`](../../../scripts/auth/README.md) and
[Portal Entra app roles](../../../../docs/developer/deploy/entra-app-roles.md#roles-for-application-identities)
for their use. `deploy/scripts/test/portal-auth-scripts.test.mjs` runs both
scripts against a stub `az`; it skips without PowerShell 7.

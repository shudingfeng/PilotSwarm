# Azure Key Vault personal secret store

A personal secret store for PilotSwarm deployments on Azure. With external
personal secrets (`PILOTSWARM_PERSONAL_SECRETS=external`), the portal hands
each personal GitHub token to the store that
`PILOTSWARM_PERSONAL_SECRET_STORE_MODULE` names and keeps only the store's
reference in PostgreSQL. This package is such a store: it keeps the tokens as
secrets in an Azure Key Vault.

It is a package of its own, with its own `package.json` and lockfile, so
PilotSwarm's packages never install or import a Key Vault SDK. Every portal
image carries it at `/app/deploy/providers/azure/secret-store/`, and nothing
loads it until the setting names it.

## Turning it on

Set on the portal:

| Setting | Value |
|---|---|
| `PILOTSWARM_PERSONAL_SECRETS` | `external`, as on every worker |
| `PILOTSWARM_PERSONAL_SECRET_STORE_MODULE` | `/app/deploy/providers/azure/secret-store/keyvault-personal-secret-store.mjs` |
| `PILOTSWARM_PERSONAL_SECRET_VAULT_URI` | The vault's URI, such as `https://myvault.vault.azure.net/` |

The portal signs in to the vault as itself, with `DefaultAzureCredential`:
in AKS, the pod's workload identity. Without
`PILOTSWARM_PERSONAL_SECRET_VAULT_URI`, or with anything other than an `https`
URI without a path, query or user name, the portal does not start.

Workers do not load this module. The store only writes and never reads a token
back; a worker gets each token from the resolver the deployment registers
(`worker.setPersonalCredentialResolver`), which reads the vault with an
identity of its own.

## The vault and the portal's role

The deployment creates the vault; this package does not. Give the vault:

- the Azure RBAC permission model;
- soft delete with purge protection. The retention can be as short as 7 days,
  the minimum, and is fixed when the vault is created;
- the network access the deployment needs, such as a private endpoint.

Grant the portal's identity a custom role on the vault with these data actions
and no others:

```json
{
  "dataActions": [
    "Microsoft.KeyVault/vaults/secrets/setSecret/action",
    "Microsoft.KeyVault/vaults/secrets/delete",
    "Microsoft.KeyVault/vaults/secrets/readMetadata/action"
  ]
}
```

`put` needs `setSecret`, `delete` needs `delete`, and `describe` and the owner
check of an update need `readMetadata`. The store never reads a value
(`getSecret`), recovers, purges, updates attributes, backs up or restores, so
the role needs none of those rights. The built-in roles grant more: Key Vault
Secrets Officer can also read values and purge.

## What it writes

- A registration writes a new secret, `ghcp-<subject>-<ID>`. `<subject>` is the
  subject of the owner's signed-in principal (with Entra sign-in, the user's
  object ID), and `<ID>` is 32 hex digits from 128 random bits. The subject
  must be 1 to 89 letters, digits or hyphens, so that the name stays within
  Key Vault's 127 characters; the store refuses an owner without a principal
  or with another subject.
- Each version is tagged `ownerOid=<subject>` and, when the token's expiry is
  known, expires with the token. Key Vault keeps the expiry in whole seconds.
- An update writes a new version of the reference's secret. It first checks
  that the name is this owner's, that the referenced version exists and that
  its `ownerOid` tag names this owner; otherwise it refuses. When the secret
  no longer exists, the update writes a new secret instead.
- `describe` lists the secret's versions, which Key Vault returns without
  their values, and answers the referenced version's `enabled` and expiry, or
  null when the secret or the version does not exist.
- `delete` soft-deletes the secret with all its versions. A secret that is
  already gone is not an error.

## Store name and references

The store calls itself `keyvault:<vault host>`, such as
`keyvault:myvault.vault.azure.net`, and every reference it returns carries
that name:

```json
{ "kind": "externalSecret", "store": "keyvault:myvault.vault.azure.net", "name": "ghcp-<subject>-<ID>", "version": "<version>", "expiresOn": "2026-12-01T00:00:00.000Z" }
```

A reference with another store's name, or with a name this store never
writes, is out of its reach, and the store leaves it alone: `describe` answers
null, `delete` does nothing, and an update writes a new secret. After a move
to another vault, providers saved earlier can still be updated and deleted,
but their old secrets stay in the old vault until someone removes them there.

## Soft delete

Key Vault keeps a deleted secret for the vault's retention period and reserves
its name until the secret is purged: writing the name again fails with
`409 Conflict` (`ObjectIsDeletedButRecoverable`). The store never writes a
removed name again, because each registration, and each update of a removed
secret, takes a fresh ID. It never recovers or purges either. With purge
protection on, Key Vault purges a deleted secret itself when the retention
period ends: 7 days after the deletion with the minimum retention.

## Tests

`npm run test:deploy-scripts` runs `test/*.test.mjs` from the repository root
against an in-memory vault (`test/fake-key-vault.mjs`), without Azure and
without this package's dependencies. To load the module with its dependencies
locally, install them from the lockfile:

```bash
npm ci --omit=dev --prefix deploy/providers/azure/secret-store
```

Keep the lockfile's `resolved` URLs on `https://registry.npmjs.org/`: the
portal image's `NPM_REGISTRY` build argument relies on npm rewriting them onto
the configured registry.

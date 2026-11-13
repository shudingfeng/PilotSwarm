# Azure provider modules for the shared deploy scripts

The logic of the Azure provider's two optional deploy profiles,
`AZURE_POLICY_RESTRICTED=true` and the Windows worker pool
(`WIN_WORKERS_ENABLED=true`), that the shared scripts in `deploy/scripts/`
need. Those scripts only import it and call it, behind the two settings, so
none of it joins the Azure code that still lives there (finding 7 of the
[provider-boundary audit](../../../../docs/architecture/provider-boundary-audit.md)).
The profiles' steps that call Azure are in [`deploy-steps/`](../deploy-steps/).

| Module | What it holds | Used by |
|---|---|---|
| `settings.mjs` | The profiles' settings: their defaults and the parsers that check them | `deploy/scripts/lib/aks-env.mjs`, which re-exports them and adds the defaults to `AKS_ENV_DEFAULTS` |
| `bicep-parameters.mjs` | The Bicep parameters the profiles add to base-infra and portal, the Windows workers' `userData` and its configuration version, and the file of secure parameters passed to `az` | `render-params.mjs`, `deploy-bicep.mjs` |
| `combos.mjs` | The combination checks that refuse a deploy before any step | `overlay-contracts.mjs` (`validateRequiredEnv`) |
| `overlay-env.mjs` | The disk controller's overlay values, the portal settings left out at their defaults, and the check of the dispatcher Ingress's trusted roots | `stage-manifests.mjs` |
| `coordination-host.mjs` | The coordination host's staging: its replicas, components, identity and CA hash, the worker image's build argument and the `all` order | `stage-manifests.mjs`, `deploy.mjs`, the Windows worker deploy steps |

With both settings off, these add no parameter, overlay value or component,
so a stamp renders and stages exactly as it did before them.

The modules import Node's built-ins, each other and generic helpers of
`deploy/scripts/lib` (`database-env.mjs`, `substitute-env.mjs`,
`workspaces.mjs`); none of those imports them back. The modules under
`deploy/scripts/lib` that held this code re-export every name that moved, so
existing imports keep working. `npm run test:deploy-scripts` covers them
through `deploy/scripts/test/`.

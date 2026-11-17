# Latest-1.0.86 correspondence

Code: `packages/sdk/src/` at `28197180`: the merge of v0.8.12 into this line (`561319e2`, upstream `f10b422c`) and the
commit after it, which changes only `session-manager.ts` (a limited system session's tools under a ceiling). 1.0.86 is
the latest version in `orchestration/`: v0.8.12's 1.0.85 with this line's owner routing, first bound as 1.0.84 at
`34e73cb1` (`CORRESPONDENCE-latest-1084.md`). No deployment ran that 1.0.84. 1.0.85 is frozen in
`orchestration_1_0_85/`; v0.8.12's 1.0.84 (tool composition), 1.0.83 and 1.0.82 stay frozen and registered.

This note binds the latest-1.0.84 batch to `28197180`. No model and no case changed: in `CapacityHold`, `OwnerCapped`,
`OwnerTagCarry` and `VersionHandoff` with `From = "83"`, read 1.0.84 as 1.0.86 and 1.0.83 as 1.0.85. Labels are those
of `CORRESPONDENCE-latest-1084.md`. Paths are under `packages/sdk/src/`, as there.

## Checks at 28197180

| Item | Verdict | Evidence at 28197180 |
|---|---|---|
| Each version maps to its exact module | holds | `orchestration-registry.ts` 86-88 `{ version: "1.0.83" }`, `"1.0.84"`, `"1.0.85"` (each from its frozen `orchestration_1_0_8x/`), 89 `{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_86 }` (from `orchestration/`); `orchestration-version.ts` 15 `"1.0.86"`; every version down to the floor, 1.0.47, stays registered |
| The frozen 1.0.85 is v0.8.12's 1.0.85 | holds | Every file equals `orchestration/` at `f10b422c` but for the version literal and the literal `"tool-composition-v1"` at the proxy sites, with no `proxy-contract` import, as 1.0.84 was frozen; enforced by `test/unit/orchestration-freeze-1-0-85.test.mjs` |
| The bound owner-routing code is unchanged | holds | `git diff 34e73cb1 28197180 -- packages/sdk/src/orchestration/`: in `turn.ts`, `lifecycle.ts`, `state.ts` and `runtime.ts` only comments (1.0.84 to 1.0.86, 1.0.83 to 1.0.85), the proxy contract (`"workflow-intake-v1"` to `LIVE_SESSION_PROXY_CONTRACT`, `"tool-composition-v1"`) and its import; `queue.ts`, `utils.ts` and the intake files byte-identical; `agents.ts` adds only v0.8.12's spawn (below) |
| What 1.0.86 changes against 1.0.85 | listed | The lines of 1.0.85 that 1.0.86 does not keep are the lines of 1.0.83 that 1.0.84 did not keep at `34e73cb1`, but for the contract and the spawn's arguments (`test/unit/orchestration-intake-1-0-83.test.mjs`, "1.0.86 keeps 1.0.83's intake whole") |
| A 1.0.85 session carries what a 1.0.83 session carries | holds | `orchestration_1_0_83/` and `orchestration_1_0_85/`: `state.ts`, `queue.ts`, `utils.ts`, the intake files and `workflow-turn-failure.ts` byte-identical; `lifecycle.ts` and `turn.ts` differ only in the contract literal, on the same lines; `agents.ts` only in the spawn, after line 832. 1.0.84 lies between them (`orchestration_1_0_84/` differs from 1.0.85 only in `agents.ts`, `index.ts` and `runtime.ts`) |
| Every change is behind an input | holds | As at `34e73cb1`: the post-turn reset is gated at `turn.ts` 1448-1449; an uncounted hold and the deny's second status publish come only from the capacity branch inside `if (runtime.options.ownerTag)` (498-525) |

## v0.8.12's spawn in 1.0.86

`orchestration/agents.ts` 850-853 (a deprecated `tool_names` with `grant` or `tools`), 950 (the parent's tool grant
is not passed on), 991-995 (the tool capture), 1006-1012 (the title lock before the child's routing) and 1024-1028
(`session.tools_granted`). The capture is a session-scoped activity, `captureSpawnToolsV1`: an owner-tagged session's
carries its owner tag (`session-proxy.ts` 996-1004), as its turns do, and like a turn it is not raced against a cap
(the 1.0.84 batch's `oc.turn-vm-lost` applies to it). `OwnerTagCarry`'s `Create` G and S (the orchestration's spawn)
hold: the capture runs before `spawnChildSession`, whose arguments still end with the child's routing
(`agents.ts` 1006-1012; `session-proxy.ts` 1350-1361). No model has the capture.

## Line map

The rows of `CORRESPONDENCE-latest-1084.md` hold at `28197180` with these lines (34e73cb1 to 28197180). Within the cited
ranges the code differs only as listed above.

| File | Lines at 34e73cb1 | Lines at 28197180 |
|---|---|---|
| `orchestration/turn.ts` | every cited line (292-335, 301, 315-317, 492-524, 501-504, 505-522, 510-517, 519, 655-668, 834, 1095-1190, 1276-1362, 1301-1319, 1309-1312, 1331-1345, 1347-1361, 1427-1451, 1440-1451, 1447-1448, 1536-1538) | the same plus 1 (one import added at line 10) |
| `orchestration/lifecycle.ts` | 182-226, 236-250, 240, 580-691, 606-720, 685, 696, 700, 716-717, 759, 782, 1161-1172, 1184-1188, 1189-1190, 1396-1397 | the same plus 1 (one import added at line 54) |
| `orchestration/state.ts` | 382-410, 508, 514, 602-615, 735-736, 738, 795-804, 852-877, 874-875 | the same lines |
| `orchestration/queue.ts` | 506, 1619, 1735 | the same lines |
| `orchestration/agents.ts` | 498-512, 499-504, 506-509, 565, 600, 653 | the same lines |
| `orchestration/agents.ts` | 982-1000 | 987-1012 (with v0.8.12's spawn) |
| `orchestration-registry.ts` | 84, 85 | 86, 89 |
| `owner-routing.ts` | 30, 60, 66-81 | 34, 64, 70-85 |
| `owner-routing.ts` | 123-155, 128-130, 162-189 | 119-151, 124-126, 158-185 |
| `session-proxy.ts` | 863-1030 (877, 1003-1009, 1017) | 874-1058 (888, 1031-1037, 1045) |
| `session-proxy.ts` | 1152-1174, 1200-1216 | 1196-1218, 1244-1260 |
| `session-proxy.ts` | 1306-1316 | 1350-1361 |
| `session-proxy.ts` | 1567-1605 | 1612-1650 |
| `session-proxy.ts` | 2168-2194 (the backstop) | 2216-2242 |
| `session-proxy.ts` | 2521-2529 | 2569-2577 |
| `session-proxy.ts` | 2939-2947, 3637-3875 (3853-3875) | 2989-2997, 3704-3966 (3942-3966) |
| `session-proxy.ts` | 6291-6316, 6321-6358 | 6636-6661, 6666-6703 |
| `session-proxy.ts` | 6791-6794 | 7150-7153 |
| `session-proxy.ts` | 7281-7295 | 7651-7665 |
| `session-proxy.ts` | 7418-7428, 7525-7544 | 7788-7798, 7895-7914 |
| `session-manager.ts` | 4004-4020 (4013-4020) | 4330-4346 (4339-4346) |
| `managed-session.ts` | 2973-2980 | 3070-3078 |
| `client.ts` | 330-347, 892-911, 956-981 | 347-365, 918-934, 979-1008 |
| `wait-affinity.ts` | 45-50 | the same lines |
| `worker.ts` | 1081, 1149-1150 | 1121, 1189-1190 |
| `design.md` (docs) | 609-622, 856-857 | 615-632, 871 |
| `orchestration_1_0_83/` (1.0.83 rows) | `turn.ts` 1219-1285, 1353-1365; `lifecycle.ts` 580-691, 659, 670, 674, 724-739, 730, 1135; `state.ts` 414-421; `agents.ts` 543, 580, 635 | the same lines of `orchestration_1_0_85/`, which equal them |

`client.ts` changed after `34e73cb1` on this line (the tag a session starts with is the one saved with its creation
config); the 1.0.84 batch does not cover the client's tagging rules, and neither does this one.

## Not covered

As in `CORRESPONDENCE-latest-1084.md`, and:

- Tool composition and durable titles themselves (`CORRESPONDENCE-latest-1085.md`), and the capture's place in the
  spawn (above).
- The worker's tag filter: with tool composition's fifth capability tag, an owner tag or the capacity tag makes six,
  one past duroxide's `MAX_WORKER_TAGS`, which duroxide-node 0.2.4 does not check (`activity-routing.ts` 188-203,
  221-246). The models take the routing as given.
- A limited system session's tools (`PILOTSWARM_LIMIT_SYSTEM_SESSION_TOOLS`) under a spawn's ceiling, a worker-side
  rule (`session-manager.ts`).

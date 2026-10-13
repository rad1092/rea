# REA static integration

This experimental integration exposes a small, enforced static JavaScript
analysis surface from REA to stdio MCP clients, Codex, and a local model host.
Use it for local artifacts you own or are authorized to inspect. Target files
are parsed as data, never imported or executed. Findings describe static
evidence and uncertainty; they do not prove runtime behavior.

The public layout is `integrations/rea-static/` inside the reviewed REA fork.
The original base is [`morluto/rea` at
`a6efa4fcefeffcf5ff5310b8154988b4be30c349`](https://github.com/morluto/rea/tree/a6efa4fcefeffcf5ff5310b8154988b4be30c349).
Its package version is 6.4.0, but the npm 6.4.0 release is based on
`a56f7bb668ab23fec8d33f7af353ac7ed2fe1895`; the version label does not establish
code identity. Use the reviewed derived fork commit containing the thread
adapter and this integration. Do not substitute an npm release or a latest tag.

## Tools and boundaries

| Public tool | Purpose |
| --- | --- |
| `rea_analyze` | Snapshot a relative directory inside the configured analysis root; return compact analysis evidence |
| `rea_discover` | List short operation summaries or one operation's actual schema |
| `rea_call` | Invoke an admitted follow-up using evidence owned by the current session |
| `rea_read_result` | Page a full result retained by this wrapper session |

Dispatch admits exactly six upstream operations:

- `analyze_javascript_application` through `rea_analyze` only
- `inspect_analysis_view`
- `trace_application_feature`
- `trace_javascript_semantics`
- `compare_application_versions`
- `compare_javascript_export_shapes`

Analysis fixes `format=directory`, `detail=summary`, and
`integrity_policy=fail`. Follow-ups accept session-owned retained evidence,
not inline evidence or native observations. For application follow-ups, use
the analysis summary's `normalized_result.parent_evidence_id`; wrapper
`result_id` values are a separate namespace. Reconnect after cancellation or
timeout and acquire fresh evidence. IDs alone confer no access.

The snapshot helper rejects symlinks, hardlinks, special files, path escapes,
and files that change during copying. REA reads private snapshots. Source-map
references are evidence data, not additional read or network permissions.
The macOS sandbox denies network and child-process creation, and denies
process sysctls under `kern.proc`. Its read set includes necessary OS/Node
libraries; filesystem metadata remains readable. Children get a clean
environment and private HOME/temp. The outer gateway still runs with its
launcher's authority; the skill text is guidance, not a sandbox.

| Enforced limit | Value |
| --- | --- |
| Snapshot | 128 files, 128 directories, 8 MiB total, 512 KiB/file, depth 12 |
| Per session | 8 snapshot attempts; 128 retained results, 32 MiB total |
| Result / transport | 2 MiB per retained result; 32 KiB request, 16 KiB response |
| Result page | Up to 6,000 UTF-16 units, reduced further to fit serialized bytes |
| Calls | One active tool call; 20 s whole-call deadline, 15 s upstream deadline |
| Source analysis | 5 s deadline; 256 MiB Worker old-generation ceiling |
| Semantic graph | Up to 5,000 nodes overall and 1,000 per file |

Heap ceilings are not an OS total-memory quota. Limit failures may invalidate
the session; they do not silently relax the policy. Private state can retain
snapshots/results after exit, so keep it private and remove it only after its
owning process has stopped.

The fork's `REA_STATIC_WORKER_THREADS=1` opt-in replaces only the source
analysis transport. Both transports use the same upstream analyzer body and
application pipeline. The gateway sets this flag in its fresh child
environment and launches Node with `--max-old-space-size=256`. The original
upstream process adapter remains the default outside this integration. A
Worker startup heap check rejects inherited settings that exceed its limit.

## Requirements and reviewed build

Runtime requirements are macOS with `/usr/bin/sandbox-exec`, `/usr/bin/git`,
and Node 22 >=22.19, Node 24 >=24.11, or Node >=26. There is no unsandboxed
fallback. Python examples require Python >=3.11 and POSIX process groups.
This integration adds no npm dependencies. The REA checkout requires its
locked dependencies; no Ghidra, Frida, Swift helper, or native decompiler is
needed for this profile.

Choose explicit absolute paths. The runtime, analysis root, and state root
must be separate, with no containment in either direction. In particular,
do not analyze `tests/fixtures` in place inside the runtime checkout: copy
owned samples to a separate analysis root. The private directory below must
be outside the runtime and analysis roots.

```sh
REA_NODE='/absolute/path/to/node'
REA_NPM_CLI='/absolute/path/to/npm/bin/npm-cli.js'
REA_RUNTIME='/absolute/path/to/reviewed-rea-checkout'
REA_INTEGRATION="$REA_RUNTIME/integrations/rea-static"
REA_ANALYSIS='/absolute/path/to/selected-artifacts'
REA_PRIVATE='/absolute/path/to/dedicated-private-data'
REA_STATE="$REA_PRIVATE/state"
REA_MANIFEST="$REA_PRIVATE/runtime-attestation.json"
REA_BUILD="$REA_PRIVATE/build"
umask 077
mkdir -p "$REA_STATE" "$REA_BUILD/home" "$REA_BUILD/tmp" "$REA_BUILD/cache"
```

Review the selected commit, `package.json`, lockfile origins/integrities, and
lifecycle scripts before installing. Install the exact lock with scripts and
optional packages disabled, including development dependencies for the
reviewed pure JavaScript TypeScript compiler:

```sh
cd "$REA_RUNTIME"
/usr/bin/env -i PATH=/usr/bin:/bin HOME="$REA_BUILD/home" TMPDIR="$REA_BUILD/tmp" \
  npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null \
  "$REA_NODE" "$REA_NPM_CLI" ci --ignore-scripts --omit=optional --include=dev \
  --no-audit --no-fund --cache "$REA_BUILD/cache"
/usr/bin/env -i PATH=/usr/bin:/bin HOME="$REA_BUILD/home" TMPDIR="$REA_BUILD/tmp" \
  NODE_DISABLE_COMPILE_CACHE=1 "$REA_NODE" --max-old-space-size=3072 \
  node_modules/typescript-termux/lib/tsc.js -p tsconfig.build.json
```

The locked `typescript-termux` compiler is TypeScript 5.9.3. This emits the
actual MCP runtime at `dist/main.js`. The regular build and `compile:termux`
scripts also invoke native tooling omitted by this profile; they are not this
build route. Do not run lifecycle rebuilds or setup scripts implicitly.

Finish and commit reviewed source/package changes before attesting. Tracked
changes must be clean, dependencies self-contained (no external symlinks),
and the exact Node version must match the launcher. Create a new manifest:

```sh
"$REA_NODE" "$REA_INTEGRATION/bin/attest-runtime.mjs" \
  "$REA_RUNTIME" "$REA_MANIFEST"
```

The gateway checks base ancestry, exact derived revision, Node version, and
hashes of `dist`, `node_modules`, and package/lock files at startup. This is
local build-integrity checking, not a publisher signature. Changes require a
fresh review/build and new manifest; the command refuses to overwrite one.
Keep manifests, installed dependencies, configuration, and analysis results
out of public commits.

## Launch and verification

Launch from an MCP client with stdio connected:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin \
  REA_ANALYSIS_ROOT="$REA_ANALYSIS" REA_UPSTREAM_ROOT="$REA_RUNTIME" \
  REA_STATE_ROOT="$REA_STATE" REA_RUNTIME_MANIFEST="$REA_MANIFEST" \
  "$REA_NODE" "$REA_INTEGRATION/bin/rea-static-mcp.mjs"
```

Run contract, template, and connector checks separately from real analysis:

```sh
cd "$REA_INTEGRATION"
"$REA_NODE" --test tests/contracts.test.mjs codex-plugin/test/materialize.test.mjs
python3 -m unittest discover -s local-llm -p 'test_*.py'
"$REA_NODE" tests/sandbox-boundaries.mjs
```

Run the real MCP workflow against the attested runtime with an **external**
scratch directory. All three overrides are necessary in the nested public
layout; test defaults are for the separate development layout.

```sh
REA_TEST_OUTPUT_DIR="$REA_PRIVATE/mcp-test" \
REA_TEST_RUNTIME="$REA_RUNTIME" REA_TEST_MANIFEST="$REA_MANIFEST" \
  "$REA_NODE" "$REA_INTEGRATION/tests/real-mcp-e2e.mjs"
```

That test creates owned inputs and state, performs real discovery/analysis
and retained-evidence follow-ups, and checks denials, paging, cancellation,
and restart. Its JSON report contains local paths and evidence; keep it
private. The boundary test also uses generated fixtures and an ephemeral
loopback listener outside the sandbox as a denial control. Model summaries
require a separate real host/model check; mocked connector tests and MCP
success do not establish model integration.

## Codex and local model hosts

`codex-plugin/` contains portable and compatibility manifests, an adapted
skill, and registration examples. Materialize a **new** local plugin copy:

```sh
"$REA_NODE" "$REA_INTEGRATION/codex-plugin/materialize.mjs" \
  --node "$REA_NODE" --integration-root "$REA_INTEGRATION" \
  --upstream-root "$REA_RUNTIME" --analysis-root "$REA_ANALYSIS" \
  --state-root "$REA_STATE" --runtime-manifest "$REA_MANIFEST" \
  --output "$REA_PRIVATE/rea-static-plugin"
```

The output must not exist or overlap the runtime, analysis, state, or template
directories. Materialization does not register or enable a plugin and does
not edit Codex settings. Actual registration is a separate, additive step
using the installed Codex version's supported local marketplace workflow.
Adapt `registration/` examples to the chosen marketplace layout; preserve
existing settings. Successful file creation, plugin loading, tool connection,
and actual analysis are separate checks.

`local-llm/rea_connector.py` is a stdlib stdio connector with explicit disabled
configuration and one session per conversation. `example_workflow.py` shows
its use. `rea_assistant.py` exposes `run_assistant(..., model_call)` for host
adaptation; its optional CLI expects the host's existing `multimodal_chat`
module and named local models. It does not supply that host, a model server,
UI routes, or automatic service/lifecycle integration. Keep host credentials
in the host process; do not add them to REA's child environment.

For the matching local host, [the Korean launch guide](local-llm/plugins/rea/README.ko.md)
documents an explicit double-click REA entrypoint. Ordinary chat UI tool use
and Q8 dispatch from this entrypoint are not implemented.

Native decompilation, target execution, debugging, Frida, CDP, native UI,
network access, and device installation remain unavailable through this
gateway. They require separately designed capabilities and target-specific
authorization; changing a skill prompt or exposing a hidden upstream tool is
not sufficient. See [NOTICE](NOTICE.md) for attribution and licenses.

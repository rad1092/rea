# Attribution and licenses

This integration is distributed inside a derived REA source checkout as
`integrations/rea-static/`. REA is by morluto and is licensed under the
[MIT license](../../LICENSE). Preserve that copyright and license notice.

The original reviewed base is
[`morluto/rea` at `a6efa4fcefeffcf5ff5310b8154988b4be30c349`](https://github.com/morluto/rea/tree/a6efa4fcefeffcf5ff5310b8154988b4be30c349).
This fork adds an experimental opt-in source-analysis Worker Threads adapter,
a restricted MCP gateway, client examples, and an adapted Codex skill. It is
not an upstream release or an endorsement by upstream.

The gateway and client examples add no third-party runtime packages. The REA
runtime and its dependencies retain their own licenses and attributions in
the repository's [third-party notices](../../THIRD_PARTY_NOTICES.md), including
the linked component license files. Keep those notices with redistributed
source or runtime dependencies. Optional external analysis engines are not
bundled by this integration.

The Codex skill is adapted to the restricted gateway workflow; it does not
copy upstream automatic setup or unpinned installation instructions.

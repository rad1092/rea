---
name: rea-static-analysis
description: Use pinned REA static tools to inspect shipped JavaScript artifacts, trace features, and compare versions with evidence. Use for artifact-level reverse engineering; ordinary source-repository explanations usually need normal code tools.
---

# REA static analysis

Use the `rea-static` plugin's fixed wrapper for the user's selected local
artifact. Start with the analysis root and target already authorized for this
task. If either is ambiguous, resolve that ambiguity before analyzing files;
nearby fixtures or paths in old reports do not select a target.

The installed connection has one explicit analysis root. A skill invocation
does not change that root, register a server, or authorize additional access.
Do not substitute the unrestricted upstream CLI/MCP server, fetch an unpinned
package, or run upstream setup to bypass an unavailable operation.

1. Discover the connected wrapper's actual schemas. It exposes `rea_analyze`,
   `rea_discover`, `rea_call`, and `rea_read_result`; do not load the upstream
   tool catalog.
2. For a JavaScript artifact, start with `rea_analyze` using the actual schema.
   Keep the initial result compact. The wrapper fixes the initial static
   analysis policy; preserve its integrity failures rather than relaxing them.
3. Use `rea_discover` for the follow-up needed by the user's question, then
   invoke an advertised operation through `rea_call` with
   `{ "tool": "<discovered name>", "arguments": { ... } }`.
   Use retained analysis views, feature/semantic traces, or version comparisons
   only when advertised by this connection. Discovery does not grant access to
   other upstream operations.
4. Preserve returned evidence identifiers, input identity/digests, locations,
   coverage, truncation, and uncertainty. Page retained evidence in the same
   session instead of repeating a large analysis. Use `rea_read_result` for
   wrapper-retained result pages and discovered analysis-view tools for
   upstream evidence; these identifiers are different namespaces.
   Evidence identifiers from a previous connection or another session are not
   transferable. If retained evidence is stale or unavailable, analyze the
   selected authorized artifact in the current connection for fresh identifiers
   and disclose evidence that could not be recovered.

Explain which findings are directly observed, which are derived or inferred,
and what remains unknown. Link findings to returned artifact locations or
evidence. An absent string, export, or call edge does not by itself prove that
a feature is absent. Static evidence does not prove runtime behavior, and a
reconstruction is not the original source code.

Read [connection and advanced boundaries](references/connection-and-advanced.md)
only when the wrapper is missing, refuses a call, or the user asks for deeper
native/runtime analysis. Continue useful work within the selected static scope
without silently widening it.

# Connection and advanced boundaries

The plugin packages the skill and a stdio connection template. Installation,
server connection, and successful analysis are separate facts. The template
contains `/CONFIGURE/` paths and cannot analyze files until a reviewed local
copy is materialized with an absolute Node binary, fixed wrapper, pinned REA
source directory, runtime attestation manifest, explicit analysis root, and
dedicated state directory.

If tools are absent, report which wrapper tools are unavailable and any observed
error. Identify missing configuration only when verified. Do not install
software or modify Codex settings automatically.
If a call is denied, inspect the wrapper's reason once. Change the request only
when the selected target and actual advertised schema support the correction.
Do not call upstream directly or change the allowlist to work around a denial.

The initial profile supports static analysis only. Deep native analysis,
decompilation providers, process execution, debugger attachment, Frida, CDP,
native UI, network access, and device installation are separate capabilities.
They remain disabled here rather than being removed from the upstream project.
When such work is requested, identify the precise target, provider, required
access and side effects. Reuse sufficient existing target-specific authorization;
obtain approval for additional access or side effects before proceeding. Runtime
work also requires an actually available, separately configured capability;
approval alone cannot add it to this static connection. Existing bring-your-own
analysis engines can be considered; buying tools or expanding system permissions
is not implied.

The wrapper's code and sandbox enforce only their implemented boundaries.
This skill is workflow guidance, not an authorization system or sandbox.
Never claim that a prompt instruction itself isolates files, blocks network
traffic, or verifies ownership.

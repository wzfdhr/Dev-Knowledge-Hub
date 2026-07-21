# Phase F Project-Level Observation

## Purpose

This runbook prepares the post-F04 observation gate. It does not enable
`DEVKH_KNOWLEDGE_KERNEL_MODE=active`, create a release, or change the current
legacy release. The application remains in `shadow` mode while an explicitly
selected non-critical project is observed.

## Scope isolation

The operational monitor accepts an optional `OBSERVATION_PROJECT_ID` UUID. When
set, the import failure-rate and shadow-stage queries filter by that project;
container health, backup freshness, and disk capacity remain workspace-level
checks. The monitor writes the selected project ID into `status.json` so a
result cannot be mistaken for a workspace-wide observation. Every run is also
appended as one sanitized line to `results.jsonl`; `status.json` is only the
latest-run pointer and is not sufficient evidence by itself.

Use a separate state directory for each project, for example:

```text
OBSERVATION_PROJECT_ID=8a01b3de-7f7e-4df6-b211-a08bf2935d2f
MONITOR_STATE_DIR=/var/lib/devkh-monitor/f05-project-8a01b3de
```

Do not put credentials, cookies, passwords, or raw source data in the
observation directory. The monitor records only status, timestamps, failure
codes, and the project UUID.

## Gate

Before starting, the product owner must identify the non-critical project and
authorize the observation. The operator then runs the existing monitor on a
15-minute timer for 24 hours and retains both root-only evidence files.

The observation fails on any project-scoped import failure-rate breach, a
terminal shadow-stage failure over the configured threshold, unhealthy
containers, stale backup, or disk-capacity breach. A failure keeps the formal
legacy release unchanged and requires technical-manager review before any
retry.

After a clean 24-hour window, the technical manager verifies the evidence and
the product manager confirms that the selected project's user-visible release,
search, Graph, citations, permissions, and feedback flows remain unchanged.
Only then may the next non-critical project be observed. Whole-workspace
expansion and any `active` switch require a separate explicit authorization.

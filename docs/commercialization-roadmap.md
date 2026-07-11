# Commercialization Roadmap

The current repository is a private `UNLICENSED` MVP, not a generally available product. Commercial work should preserve citation integrity and explicit publication while adding operational controls in measured gates.

## Gate 1: Design partners

- Validate repository sync, cited answers, feedback/rebuild, and operator workload with a small number of contracted private deployments.
- Add product analytics that exclude source, prompts, credentials, and citation content by default.
- Define support, backup, restore, upgrade, and security incident runbooks with service objectives.
- Establish pricing hypotheses by active repository, indexed code volume, and operator seats; do not meter MCP query content.

Exit criteria: repeat usage, measured answer usefulness, successful restore drills, documented support load, and no unresolved critical security findings.

## Gate 2: Managed private beta

- Add organization lifecycle, SSO/MFA, RBAC, session revocation, audit export, tenant deletion/export, and per-tenant encryption boundaries.
- Move rate limiting, queueing, secrets, backups, observability, and artifact storage to managed shared services with tenant quotas.
- Add signed releases, deployment migrations/rollback policy, SBOM/image scanning, dependency updates, and regional data controls.
- Complete legal terms, privacy/DPA, subprocessors, retention, vulnerability disclosure, and commercial license decisions.

Exit criteria: independent threat model and penetration test, restore/RTO evidence, tenant isolation tests, billing reconciliation, and approved legal/security launch review.

## Gate 3: General availability

- Publish support tiers, uptime objectives, status/incident communications, capacity policy, and deprecation/versioning guarantees.
- Add enterprise repository controls, customer-managed keys where justified, SIEM integration, compliance evidence, and continuous recovery exercises.
- Require staged rollouts, automated rollback signals, canaries, and backward-compatible database/API/MCP evolution.

Exit criteria: production readiness review, on-call ownership, audited controls, sustainable unit economics, and explicit authorization to replace private-only positioning.

## Product principles

- Every knowledge answer remains tied to a published immutable commit with exact citations.
- Builds and feedback rebuilds never publish automatically.
- Source and credentials are customer data, not training or analytics material without explicit agreement.
- Commercial pressure does not weaken clean-room provenance, license policy, tenant isolation, or release gates.

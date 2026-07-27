# React Router RSC audit exception — 2026-07-27

## Decision

The release verifier temporarily accepts the two high-severity npm audit findings
for `react-router` and `react-router-dom` that resolve exclusively to
<https://github.com/advisories/GHSA-qwww-vcr4-c8h2>.

The exception was explicitly approved for this FK17 candidate in the delivery
conversation on 2026-07-27. It expires automatically at
`2026-08-27T00:00:00.000Z` and must not be renewed silently.

## Bounded scope

The exception is valid only when all of the following are true:

- the audit report is complete and has no critical finding;
- the only high findings are the direct `react-router` and `react-router-dom`
  findings for the advisory above;
- the lockfile resolves both packages to a 7.x release in the affected range;
- this is a Vite application and neither `react-router` nor any
  `@react-router/*` package is a direct dependency; and
- `src/` contains no unstable React Router RSC API (`RSC*`,
  `createCallServer`, or `createClientRoutes`).

Any other high finding, an incomplete audit report, detected RSC usage, a new
direct framework dependency, or the expiry date makes `runtime:verify` fail.

## Follow-up

Upgrade to the first registry-published patched React Router release (the
advisory lists 8.3.0) as soon as it is available and remove this exception.
Recheck the advisory before the expiry date, then record either the upgrade or
an explicit new authorization.

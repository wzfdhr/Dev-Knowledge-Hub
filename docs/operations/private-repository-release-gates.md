# Private Repository Release Gates

This repository remains private. The current GitHub account plan does not support branch protection for private repositories, so required checks are enforced by a trusted GitHub Actions merge workflow instead of the GitHub merge button.

## Required checks

Every phase pull request must have successful, completed checks named:

- `verify`
- `container-smoke`

Running `npm run release:verify` without a scope executes only the non-destructive `verify` checks.
The destructive container scope refuses to start unless `DEVKH_CONTAINER_SMOKE=true` and
`COMPOSE_PROJECT_NAME` is `devkh-ci` or a `devkh-ci-<suffix>` project. This keeps its final
`docker compose down --volumes` confined to disposable CI volumes.

The pull request must target `main`, must no longer be a draft, and must have explicit user approval recorded in the phase review.

After that approval, merge with:

```bash
npm run phase:merge -- <pull-request-number> --user-approved --approved-head <reviewed-40-character-sha>
```

The command reloads the remote pull request state, binds the request to the explicitly approved head, and dispatches `phase-merge.yml` from `main`. That trusted workflow checks out the approved SHA with a read-only token, runs fresh `verify` and `container-smoke` jobs, and grants write permission only to a separate final merge job. The merge job requires the workflow actor to be the repository owner, then revalidates the open PR, target branch, draft state, and exact head before calling GitHub with `--match-head-commit`. A failed, cancelled, or superseded verification run cannot reach the merge job. Do not merge phase branches through the GitHub web button.

`phase-merge.yml` must already exist on the default branch because GitHub only accepts `workflow_dispatch` for workflows registered there. Installing this workflow in Phase A is a one-time bootstrap: after all Phase A checks and reviews pass, the user must explicitly authorize that initial merge. Every later phase uses the trusted workflow without a bootstrap exception.

Making the repository public is not an acceptable workaround. If the account later supports private-repository branch protection, keep this command and also configure `verify` and `container-smoke` as GitHub required checks.

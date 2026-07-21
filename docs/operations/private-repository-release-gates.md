# Private Repository Release Gates

This repository remains private. The current GitHub account plan does not support branch protection for private repositories, so required checks are enforced by a trusted GitHub Actions merge workflow instead of the GitHub merge button.

## Required checks

Every phase pull request must have successful, completed checks named:

- `verify`
- `container-smoke`

Running `npm run release:verify` without a scope executes only the non-destructive `verify` checks.
The destructive container scope refuses to start unless `DEVKH_CONTAINER_SMOKE=true` and
`COMPOSE_PROJECT_NAME` is `devkh-ci` or a `devkh-ci-<suffix>` project. This keeps its final
`docker compose -f "$GITHUB_WORKSPACE/docker-compose.yml" down --volumes` confined to disposable CI volumes.

The pull request must target `main`, must no longer be a draft, and must have explicit user approval recorded in the phase review.

After that approval, merge with:

```bash
npm run phase:merge -- <pull-request-number> --user-approved --approved-head <reviewed-head-40-character-sha> --approved-base <reviewed-main-40-character-sha>
```

The command reloads the remote pull request state and rejects it unless both the explicitly approved head and the explicitly approved `main` base still match. It then dispatches `phase-merge.yml` from `main`. That workflow checks out the approved SHA with a read-only token, verifies that the approved base is its ancestor, and runs fresh `verify` and `container-smoke` jobs. FK17 gate enforcement is not loaded from that candidate checkout: each job extracts the verifier and its lockfile-bound dependencies from the exact reviewed revision in the `DEVKH_FK17_BOOTSTRAP_COMMIT` repository variable, verifies the active workflow and candidate gate blobs against that revision, and runs `npm ci --ignore-scripts` in the extracted tree before invoking it. Only then does a separate write-enabled job revalidate the open PR, target branch, draft state, exact base, and exact head. It creates a merge commit from the approved base and head, then atomically updates `main` with `git push --force-with-lease=refs/heads/main:<approved-base>`. If `main` changes at any point, that compare-and-swap push is rejected. A failed, cancelled, superseded, or base/head-drifted run cannot merge. Do not merge phase branches through the GitHub web button.

`phase-merge.yml` and the FK17 verifier must already exist in a reviewed default-branch bootstrap revision because GitHub only accepts `workflow_dispatch` for workflows registered there. Record that exact 40-character revision in `DEVKH_FK17_BOOTSTRAP_COMMIT`; absence, non-ancestry, or any workflow/verifier blob mismatch fails closed. The Phase Merge approval artifact binds the same bootstrap commit and exact workflow/verifier blob identities, so a candidate cannot inherit approval while replacing enforcement code. Changing those files requires a separately reviewed bootstrap rotation before any candidate may rely on them. Installing this trust root in Phase A remains a one-time external prerequisite: after all Phase A checks and reviews pass, the user must explicitly authorize a release owner to create the same merge commit locally from the reviewed base and head, then update `main` with the same `--force-with-lease` comparison. If the lease rejects, the branch must be rebased and fully re-reviewed.

Making the repository public is not an acceptable workaround. If the account later supports private-repository branch protection, keep this command and also configure `verify` and `container-smoke` as GitHub required checks.

# Private Repository Release Gates

This repository remains private. The current GitHub account plan does not support branch protection for private repositories, so required checks are enforced by the project merge command instead of the GitHub merge button.

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

The command reloads the remote pull request state, refuses missing, pending, cancelled, or failed checks, and requires the current PR head to equal the commit explicitly approved by the user. GitHub also receives `--match-head-commit`, so a push racing the merge cannot replace the approved content. The command uses a merge commit so task commits remain visible. Do not merge phase branches through the GitHub web button.

Making the repository public is not an acceptable workaround. If the account later supports private-repository branch protection, keep this command and also configure `verify` and `container-smoke` as GitHub required checks.

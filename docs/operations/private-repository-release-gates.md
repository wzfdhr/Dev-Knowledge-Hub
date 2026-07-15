# Private Repository Release Gates

This repository remains private. The current GitHub account plan does not support branch protection for private repositories, so required checks are enforced by the project merge command instead of the GitHub merge button.

## Required checks

Every phase pull request must have successful, completed checks named:

- `verify`
- `container-smoke`

The pull request must target `main`, must no longer be a draft, and must have explicit user approval recorded in the phase review.

After that approval, merge with:

```bash
npm run phase:merge -- <pull-request-number> --user-approved
```

The command reloads the remote pull request state, refuses missing, pending, cancelled, or failed checks, and uses a merge commit so task commits remain visible. Do not merge phase branches through the GitHub web button.

Making the repository public is not an acceptable workaround. If the account later supports private-repository branch protection, keep this command and also configure `verify` and `container-smoke` as GitHub required checks.

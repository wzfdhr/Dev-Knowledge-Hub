# Session Rollout

The server stores only SHA-256 hashes of opaque session IDs and CSRF nonces. `devkh_session` is HttpOnly; `devkh_csrf` is a Strict, browser-readable cookie. The client sends the CSRF value in `X-Devkh-Csrf` for every authenticated write.

For the migration deployment only, set `DEVKH_LEGACY_SESSION_READ_UNTIL` to a UTC ISO 8601 timestamp no more than 24 hours after deployment, for example:

```sh
DEVKH_LEGACY_SESSION_READ_UNTIL=2026-07-15T12:00:00.000Z
```

Before the timestamp, pre-migration JWT cookies may read authenticated pages. They cannot write and receive `SESSION_REFRESH_REQUIRED`, so users must sign in again. After the timestamp, remove the variable and restart the service; old JWT cookies are rejected. Never extend the window or restore JWT cookie issuance.

Rollback is forward-only: stop the release, restore the verified database and data backup if required, and keep `auth_sessions` intact. Do not run destructive down migrations in production.

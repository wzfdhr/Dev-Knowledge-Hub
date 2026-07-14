# Operations Monitoring Design

## Goal

Provide a host-local, scheduled health monitor for the small-team deployment without requiring
a third-party notification account.

## Checks

- The application health endpoint on localhost returns HTTP 200.
- The Compose app and PostgreSQL services both report healthy.
- The filesystem containing Docker data remains below the configured usage threshold of 85%.
- The latest encrypted Restic backup is no older than 30 hours.

## Behavior

The monitor runs every five minutes as a hardened root-only systemd oneshot service. It sources
the existing root-only backup environment only to query Restic; it never prints credentials. It
writes a sanitized status document below `/var/lib/devkh-monitor` and exits nonzero on any
failed check, producing a high-priority systemd failure signal.

## Non-goals

- Do not send email, chat, SMS, or webhook notifications until a delivery channel is selected.
- Do not expose monitoring data through the application API.
- Do not restart failed containers automatically.

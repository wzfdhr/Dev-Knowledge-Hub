# Parser Runtime

The frontend parser runs as the `parser` Compose service. The API sends validated source bytes over
`/run/devkh-parser/parser.sock`; it never sends host paths, repository credentials, database access,
or executable configuration.

## Security boundary

- `network_mode: none`, read-only root filesystem, non-root `node` user.
- All Linux capabilities are dropped and `no-new-privileges` is enabled.
- The only persistent mount is `parser_runtime:/run/devkh-parser`.
- `/tmp` is a bounded `noexec,nosuid` tmpfs.
- CPU, memory, PID, worker heap, stack, request, output, and wall-clock limits are enforced.
- Every source path is a relative POSIX virtual path and every byte payload must match its SHA-256 hash.
- The socket is recreated on service start with mode `0600`.

The parser currently validates and transports Frontend IR v2 inputs. Concrete analyzers are added by
later FK tasks; parser code must never load project plugins, config files, package scripts, or arbitrary
modules from uploaded sources.

## Failure behavior

`PARSER_RUNTIME_UNAVAILABLE`, `PARSER_TIMEOUT`, `PARSER_CANCELLED`, `PARSER_WORKER_CRASH`,
`PARSER_OUTPUT_LIMIT`, and `PARSER_INVALID_REQUEST` are stable stage failure codes. A parser failure
fails only the current v2 stage. Legacy project builds and all historical release reads remain available.

Restarting `parser` recreates the socket and does not require restarting PostgreSQL. Queued stage runs
are retried only according to the existing pipeline retry policy.

## Verification

```bash
npm run test:runtime
npm run delivery:verify
docker compose -f docker-compose.yml config --quiet
```

The release `container-smoke` gate starts the real service and runs
`scripts/security/verify-parser-container.mjs` against Docker inspect data. To diagnose a failure:

```bash
docker compose -f docker-compose.yml ps parser
docker compose -f docker-compose.yml logs parser
```

Never add database, snapshot, upload, repository, artifact, or secret mounts to this service.

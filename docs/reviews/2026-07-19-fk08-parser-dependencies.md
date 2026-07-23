# FK08 Parser Dependency Review

Date: 2026-07-19

Decision: approved by the user as option 1. All five parsers are permitted for the FK08 shadow pipeline.

Follow-up decision: indented `.sass` syntax is explicitly partial and deferred to V1 Trial. `postcss-sass@0.5.0` was rejected because its last release was in 2022 and it adds the older `gonzales-pe` parser. SCSS and Less remain V1 Core.

## Locked packages

| Capability | Package | Version | License | Unpacked bytes | Registry modified |
| --- | --- | ---: | --- | ---: | --- |
| HTML | `parse5` | 8.0.1 | MIT | 337,099 | 2026-04-19 |
| CSS | `postcss` | 8.5.19 | MIT | 214,823 | 2026-07-13 |
| Selectors | `postcss-selector-parser` | 7.1.4 | MIT | 212,373 | 2026-06-11 |
| SCSS | `postcss-scss` | 4.0.9 | MIT | 19,425 | 2023-09-28 |
| Less | `postcss-less` | 6.0.0 | MIT | 21,904 | 2022-06-24 |

The direct unpacked total is 805,624 bytes. `parse5` and PostCSS were already present transitively in development tooling, but FK08 makes the approved versions direct and exact production dependencies. `npm audit --omit=dev` reported zero known vulnerabilities at approval time.

## Maintenance assessment

- `parse5`, PostCSS, and the selector parser have recent releases and active maintainers.
- The SCSS and Less syntax adapters have older release dates. They are small syntax adapters with PostCSS 8 peer contracts, but their slower maintenance is a known risk.
- The version manifest and license gate reject silent parser upgrades. Any replacement or version-range expansion requires a new dependency review and fixture evidence.

## Untrusted-input controls

- Parsing runs only in the dedicated no-network parser service and a terminable worker thread. It does not run package scripts, imported modules, HTML scripts, CSS functions, or configuration code.
- Virtual paths are normalized project-relative POSIX paths. Host filesystem paths, `node_modules`, duplicate paths, non-canonical base64, and hash mismatches are rejected before analysis.
- The parser service enforces a 2 MiB per-file limit, 32 MiB total request-source limit, 64 MiB framed-protocol limit, 30-second worker deadline, 256 MiB old-generation heap limit, 32 MiB young-generation limit, 8 MiB stack, and 16 MiB/100,000-node/256-depth output limits.
- Parse failures produce bounded partial facts or a stable parser error. They cannot alter the current release because FK08 remains shadow-only.
- Source-analysis cache entries are immutable, workspace-scoped, content-addressed, parser-versioned JSON facts. Project paths, snapshot IDs, source refs, credentials, and storage paths are rejected from cached facts.

## Remaining gates

- Full unit, parser-runtime, license, typecheck, lint, build, PostgreSQL integration, and container checks must pass before the V1 Demo review.
- FK13 must add held-out quality evidence before any analyzer capability can be exposed outside administrator shadow preview.

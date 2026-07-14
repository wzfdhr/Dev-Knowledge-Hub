# Vue Console Baseline

The Vue console is intentionally a framework baseline, not a second component library.

- Entry: `/console-vue/*`
- Health route: `/console-vue/health`
- React remains the current default entry.
- Vue uses project-owned CSS tokens and project-owned components only. Do not add `aheart-ui`, Ant Design Vue, Element Plus, or another UI component package. Existing React dependencies are unchanged until the explicit Vue migration gate.
- The server inserts the existing per-response CSP nonce into both React and Vue HTML entrypoints. The Vue shell detects that nonce without widening CSP.

Rollback is route-level: remove the Vue entrypoint from the build and keep the React entrypoint untouched. No database migration is involved.

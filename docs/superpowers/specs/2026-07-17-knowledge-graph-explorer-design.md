# Knowledge Graph Explorer Design

## Goal

Replace the project graph page's JSON debug output with a usable, traceable graph explorer for a published project release. The work stays on an isolated frontend branch and does not alter the shadow-kernel observation or production release behavior.

## Product Scope

The explorer makes the existing published graph useful for a small development team:

- Start from modules, then reveal contained symbols, documents, tables, and columns.
- Make verified facts and candidate relationships visually distinct.
- Let members search, filter, select, pan, zoom, and inspect graph entities without leaving the page.
- Show exact source references for the selected node or edge and load the existing release-scoped source excerpt on demand.
- Provide download/copy actions for the server-generated Mermaid and Markmap representations.

The page does not create, edit, publish, or rebuild graph data. It remains read-only for any user with the existing project `reader` permission.

## Considered Approaches

1. **Custom SVG explorer, recommended.** A deterministic containment layout rendered by React SVG provides inspectable nodes and edges, pointer pan/zoom, keyboard selection, and a responsive detail panel without adding a visualization runtime. It suits the project's private 2–10 person team and preserves the existing no-new-UI-library constraint.
2. **Force-directed graph library.** This gives fast visual impact but adds an unplanned dependency, nondeterministic layouts, harder accessibility, and a larger production bundle. It is rejected for this phase.
3. **Tree/table only.** This is compact but repeats the current JSON problem: dependency relationships and cross-links remain hard to understand. It is rejected.

## Architecture

The existing `GET /api/projects/:projectId/graph` endpoint remains authoritative. The client fetches its `json` representation for the interactive view and fetches `mermaid` or `markmap` only when the user requests export. The API response is release-bound, project-authorized, and contains no unpublished graph state, so no server contract or database migration is needed.

Create a client-only graph view-model layer that:

1. Parses the typed graph response into nodes and edges.
2. Applies the selected kinds, candidate toggle, and text query before layout.
3. Keeps every displayed fact edge only when both endpoints are displayed; candidate edges are opt-in and visually dashed.
4. Produces a deterministic module-first layout: top-level modules are arranged in columns, contained entities vertically beneath their owner, and cross relations are overlaid as curved SVG paths.
5. Caps the initial display at 160 nodes. When a release exceeds that threshold, the page explains the reduction and lets the user narrow with search/filter rather than silently rendering an unreadable graph.

The page owns interaction state only: selected item, filter values, query, transform, and source excerpt selection. The existing query cache owns all server data.

## Experience Design

### Desktop

The page header shows the published version, visible/total node and edge counts, and icon-labelled export commands. A compact toolbar contains a search input, node-kind checkbox filters, a candidate-edge toggle, and zoom/reset icon buttons with tooltips.

The central graph surface is an SVG viewport with a stable minimum height. Nodes use a restrained semantic color system by kind, retain a fixed hit area, and expose accessible labels. Fact edges are solid; candidate edges are dashed and do not visually outrank facts. Selecting a node or edge updates a right-side detail panel rather than expanding a card inside the graph.

The detail panel shows kind, qualified name, attributes, relationship direction, confidence/candidate reason, and source references. Selecting a source reference loads the existing release-scoped source excerpt in that panel. The graph remains visible while details change.

### Mobile

Below 760px, controls wrap without overflow, the graph keeps a constrained scroll-safe viewport, and the detail panel moves below it. Pan remains available; zoom controls remain explicit. The page never relies on hover to reveal essential information.

### Empty and Failure States

No released graph keeps the existing onboarding message. A network/API error uses the existing retry state. A graph with no nodes explains that the release contains no accepted graph entities. A graph exceeding the initial display limit is a usable filtered state, not an error.

## Accessibility

- Every graph node and edge has an accessible name and supports keyboard selection through a focusable list synchronized with the SVG selection.
- Toolbar controls use native inputs, labelled buttons, and visible focus states.
- Reduced-motion mode removes transform transitions and animated emphasis.
- Color is never the only fact/candidate distinction; labels and line styles remain available.

## Data and Security Constraints

- Keep `/api/projects/:projectId/graph` permission and release behavior unchanged.
- Only render data from the selected published release.
- Do not expose storage paths, raw artifact contents, credentials, unpublished builds, or another project's graph.
- Source previews continue through `GET /api/knowledge/source` with the selected release ID and existing server-side range validation.
- Mermaid and Markmap output is obtained from the server and treated as plain downloadable text; the browser never executes Mermaid or Markmap content.

## Testing and Acceptance

- Unit test the view-model: deterministic layout, filtering, candidate suppression, search, display cap, and citation selection.
- Component test: graph response renders semantic nodes/edges, filters update visible counts, keyboard selection changes details, source loading uses the selected release, and export actions use server text.
- Preserve API route tests for JSON/tree/Mermaid/Markmap and project authorization.
- Run unit tests, lint, typecheck, build, E2E desktop/mobile checks, and production visual review before any independent UI deployment.

## Delivery Boundary

The branch is `codex/graph-explorer`. It will have its own commits and draft PR. It will not be deployed into the current F04 shadow-observation environment until independently reviewed and explicitly approved; deploying it would restart the visual acceptance baseline, not alter legacy/pipeline release provenance.

# Frontend Experience Kernel — Figma handoff

## Formal artifact

- File: [Dev Knowledge Hub — Frontend Experience Kernel](https://www.figma.com/design/uf7puLJFuznpK9H5gwCCOM)
- File key: `uf7puLJFuznpK9H5gwCCOM`
- Source of truth: `src/client/styles.css`, `src/client/responsive.css`, and the experience components.

The formal file was created on 2026-07-22. The connected Starter workspace rejected subsequent canvas operations after its MCP tool-call allowance was exhausted. No inaccessible or fabricated frame is claimed in this handoff. The frame specification below is implementation-complete in code and can be replayed into the formal file when the workspace allowance is restored.

## Code-derived system

- Typeface: Inter, with system UI fallbacks.
- Ink: `#172033`; muted: `#647084`; border: `#dce1e7`; surface: `#ffffff`.
- Action: `#1769e0`; success: `#168354`; warning: `#c58214`; danger: `#b42318`.
- Spacing base: 4px; common gaps: 8, 12, 16, 24, 28, 32px.
- Radius: 5–7px. Experience content uses bands and dividers instead of nested cards.
- Existing Ant Design controls remain the reusable implementation library. The experience views add only local bands, state labels, citations, and review rows.

## Required frames

Each view has a 1440px and 390px frame specification:

1. Engineering experience library — ready/member.
2. Administrator review queue, as a controlled view under `/knowledge/experiences`.
3. Codex structured solution context, with six visibly separate regions.
4. `no_release` state.
5. `no_applicable_experience` state.

The six solution regions are current facts, hard constraints, applicable prior experience, rejected candidates, unknowns, and impact/verification. Current facts, prior experience, and rejected candidates must never share the same visual container.

## Responsive and accessibility acceptance

- At 390px, all multi-column layouts collapse to one column and review actions become full-width.
- No horizontal document overflow at 390px; paths and citations wrap within their region.
- All views retain a single `h1`, named navigation/regions, visible focus indicators, and text labels for status (color is not the only signal).
- UI tests are the durable replay contract for roles, seven states, review reason requirements, and structured solution partitions.

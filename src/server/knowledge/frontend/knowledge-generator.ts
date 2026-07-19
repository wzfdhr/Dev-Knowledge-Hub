import { createHash } from "node:crypto";

import type { SourceRef } from "../../../shared/api-contracts.js";
import type { FrontendEntity, FrontendIR } from "../../../shared/frontend-ir.js";

export interface FrontendKnowledgePage {
  id: string;
  slug: string;
  title: string;
  kind: "architecture" | "routes" | "components" | "data" | "visualizations" | "tooling-tests";
  items: Array<{ entityId: string; kind: FrontendEntity["kind"]; name: string; qualifiedName: string; sourceRefs: SourceRef[] }>;
  citations: SourceRef[];
  chunks: Array<{ heading: string; content: string; citations: SourceRef[] }>;
}

const sections: Array<{ slug: string; title: string; kind: FrontendKnowledgePage["kind"]; entityKinds: FrontendEntity["kind"][] }> = [
  { slug: "frontend-architecture", title: "Frontend Architecture", kind: "architecture", entityKinds: ["workspace_package", "application_entry", "dom_landmark"] },
  { slug: "frontend-components", title: "Components and Design", kind: "components", entityKinds: ["component", "style_scope", "style_token", "form"] },
  { slug: "frontend-data", title: "State and Data", kind: "data", entityKinds: ["state_store", "state_field", "api_operation", "data_schema"] },
  { slug: "frontend-routes", title: "Routes and Pages", kind: "routes", entityKinds: ["route", "layout", "page"] },
  { slug: "frontend-tooling-tests", title: "Tooling and Tests", kind: "tooling-tests", entityKinds: ["tooling_config", "test_case", "test_fixture"] },
  { slug: "frontend-visualizations", title: "Visualizations", kind: "visualizations", entityKinds: ["visualization"] }
];

function refs(entities: FrontendEntity[]): SourceRef[] {
  return [...new Map(entities.flatMap((entity) => entity.sourceRefs).map((item) => [JSON.stringify(item), item])).values()];
}

export function generateFrontendKnowledge(ir: FrontendIR): { schemaVersion: 2; snapshotId: string; pages: FrontendKnowledgePage[] } {
  const pages = sections.flatMap((section) => {
    const entities = ir.entities.filter((entity) => section.entityKinds.includes(entity.kind));
    if (entities.length === 0) return [];
    const citations = refs(entities);
    const content = entities.map((entity) => `${entity.kind}: ${entity.qualifiedName}`).join("\n");
    return [{
      id: createHash("sha256").update(`${ir.snapshotId}:${section.slug}`).digest("hex"),
      slug: section.slug,
      title: section.title,
      kind: section.kind,
      items: entities.map((entity) => ({
        entityId: entity.id,
        kind: entity.kind,
        name: entity.name,
        qualifiedName: entity.qualifiedName,
        sourceRefs: entity.sourceRefs
      })),
      citations,
      chunks: [{ heading: section.title, content, citations }]
    }];
  }).sort((left, right) => left.slug.localeCompare(right.slug));
  return { schemaVersion: 2, snapshotId: ir.snapshotId, pages };
}

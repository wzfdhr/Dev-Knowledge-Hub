import type { FrontendIR } from "../../../shared/frontend-ir.js";

export function deriveFrontendChangeImpact(input: { changedPaths: string[]; graph: FrontendIR }) {
  const changed = new Set(input.changedPaths);
  const affected = new Set(input.graph.entities.filter((entity) =>
    entity.sourceRefs.some((reference) => changed.has(reference.path))
  ).map((entity) => entity.id));
  const factEdges = input.graph.edges.filter((edge) => edge.evidenceClass === "fact");
  const queue = [...affected];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of factEdges) {
      if (edge.toEntityId !== current) continue;
      const neighbor = edge.fromEntityId;
      if (!affected.has(neighbor)) {
        affected.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  const entities = input.graph.entities.filter((entity) => affected.has(entity.id));
  const tests = entities.filter((entity) => entity.kind === "test_case");
  return {
    changedPaths: [...changed].sort(),
    affectedEntityIds: entities.map((entity) => entity.id).sort(),
    affectedPageIds: entities.filter((entity) => entity.kind === "page" || entity.kind === "route").map((entity) => entity.id).sort(),
    suggestedTestIds: tests.map((entity) => entity.id).sort(),
    suggestedTestPaths: [...new Set(tests.flatMap((entity) => entity.sourceRefs.map((reference) => reference.path)))].sort(),
    affectedPaths: [...new Set(entities.flatMap((entity) => entity.sourceRefs.map((reference) => reference.path)))].sort()
  };
}

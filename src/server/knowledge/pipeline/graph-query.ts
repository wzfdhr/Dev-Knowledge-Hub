import type { KnowledgeGraphRecord, ReleaseRecord } from "../../persistence/store.js";

export interface PublishedGraphStore {
  currentRelease(workspaceId: string, repositoryId: string): Promise<ReleaseRecord | null>;
  getRelease(workspaceId: string, releaseId: string): Promise<ReleaseRecord | null>;
  getKnowledgeGraph(workspaceId: string, projectId: string, buildId: string): Promise<KnowledgeGraphRecord | null>;
}

export async function loadPublishedKnowledgeGraph({
  store,
  workspaceId,
  projectId,
  repositoryId,
  releaseId
}: {
  store: PublishedGraphStore;
  workspaceId: string;
  projectId: string;
  repositoryId: string;
  releaseId?: string;
}): Promise<{ release: ReleaseRecord; graph: KnowledgeGraphRecord } | null> {
  const release = releaseId
    ? await store.getRelease(workspaceId, releaseId)
    : await store.currentRelease(workspaceId, repositoryId);
  if (!release || release.repositoryId !== repositoryId || release.publishedAt === null) return null;
  const graph = await store.getKnowledgeGraph(workspaceId, projectId, release.buildId);
  return graph ? { release, graph } : null;
}

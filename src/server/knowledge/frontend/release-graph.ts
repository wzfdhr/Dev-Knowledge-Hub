import type { ArtifactManifest } from "../../../shared/api-contracts.js";
import { frontendGraphV2Schema, frontendPipelinePackageSchema } from "./compatibility.js";

export class FrontendReleaseGraphUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontendReleaseGraphUnavailableError";
  }
}

export async function loadPublishedFrontendGraph(input: {
  release: { workspaceId: string; buildId: string; snapshotId: string; packageArtifactId: string | null; releaseArtifactFamily: string };
  workspaceId: string;
  projectId: string;
  store: { findArtifactById(id: string): Promise<ArtifactManifest | null> };
  reader: { getJson(manifest: ArtifactManifest): Promise<unknown> };
}) {
  if (input.release.releaseArtifactFamily !== "frontend-v2" || !input.release.packageArtifactId) {
    throw new FrontendReleaseGraphUnavailableError("Release does not contain a frontend graph package");
  }
  if (input.release.workspaceId !== input.workspaceId) {
    throw new FrontendReleaseGraphUnavailableError("Frontend release is outside the workspace scope");
  }
  const packageManifest = await input.store.findArtifactById(input.release.packageArtifactId);
  if (!packageManifest || packageManifest.workspaceId !== input.workspaceId || packageManifest.projectId !== input.projectId
    || packageManifest.buildId !== input.release.buildId || packageManifest.snapshotId !== input.release.snapshotId
    || packageManifest.stage !== "package" || packageManifest.kind !== "frontend-pipeline-package") {
    throw new FrontendReleaseGraphUnavailableError("Frontend release package is unavailable");
  }
  const packageValue = frontendPipelinePackageSchema.parse(await input.reader.getJson(packageManifest));
  if (packageValue.snapshotId !== input.release.snapshotId) {
    throw new FrontendReleaseGraphUnavailableError("Frontend release package snapshot does not match");
  }
  const graphId = packageValue.artifacts.graph.find((id) => id !== "legacy-graph");
  if (!graphId) throw new FrontendReleaseGraphUnavailableError("Frontend graph is missing from release package");
  const graphManifest = await input.store.findArtifactById(graphId);
  if (!graphManifest || graphManifest.workspaceId !== input.workspaceId || graphManifest.projectId !== input.projectId
    || graphManifest.buildId !== input.release.buildId || graphManifest.snapshotId !== input.release.snapshotId
    || graphManifest.stage !== "graph" || graphManifest.kind !== "frontend-graph-v2") {
    throw new FrontendReleaseGraphUnavailableError("Frontend graph artifact is unavailable");
  }
  return frontendGraphV2Schema.parse(await input.reader.getJson(graphManifest));
}

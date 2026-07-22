import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const digest = /^[a-f0-9]{64}$/u;

function scoped(workspaceId, id) {
  return `${String(workspaceId)}\0${String(id)}`;
}

function records(value, name, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return [];
  }
  return value;
}

function indexByWorkspace(values, name, errors) {
  const index = new Map();
  for (const value of values) {
    if (!value || typeof value !== "object" || !value.workspaceId || !value.id) {
      errors.push(`${name} identity missing`);
      continue;
    }
    const key = scoped(value.workspaceId, value.id);
    if (index.has(key)) errors.push(`${name} duplicate identity ${value.id}`);
    else index.set(key, value);
  }
  return index;
}

function checkSupersession(values, label, errors) {
  const index = indexByWorkspace(values, label, errors);
  for (const value of values) {
    if (!value?.supersededById) continue;
    const target = index.get(scoped(value.workspaceId, value.supersededById));
    if (!target) {
      errors.push(`${label} supersession target missing ${value.supersededById}`);
      continue;
    }
    const seen = new Set([value.id]);
    let cursor = target;
    while (cursor) {
      if (seen.has(cursor.id)) {
        errors.push(`${label} supersession cycle ${value.id}`);
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.supersededById
        ? index.get(scoped(cursor.workspaceId, cursor.supersededById))
        : null;
    }
  }
  return index;
}

export function validateExperienceRecoveryEvidence(input) {
  const errors = [];
  const database = input?.restoredDatabase;
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    return { ok: false, errors: ["restoredDatabase must be an object"], counts: {} };
  }
  const sourceSnapshots = records(database.sourceSnapshots, "sourceSnapshots", errors);
  const releases = records(database.releases, "releases", errors);
  const projectProfiles = records(database.projectProfiles, "projectProfiles", errors);
  const patternGroups = records(database.patternGroups, "patternGroups", errors);
  const evidence = records(database.evidence, "evidence", errors);
  const decisions = records(database.decisions, "decisions", errors);
  const outcomes = records(database.outcomes, "outcomes", errors);
  const reviews = records(database.reviews, "reviews", errors);
  const reviewItems = records(database.reviewItems, "reviewItems", errors);
  const standards = records(database.standards, "standards", errors);
  const artifacts = records(input?.restoredArtifacts, "restoredArtifacts", errors);

  const snapshotsById = indexByWorkspace(sourceSnapshots, "source snapshot", errors);
  const releasesById = indexByWorkspace(releases, "release", errors);
  const groupsById = checkSupersession(patternGroups, "pattern group", errors);
  const evidenceById = indexByWorkspace(evidence, "experience evidence", errors);
  const decisionsById = indexByWorkspace(decisions, "experience decision", errors);
  const outcomesById = indexByWorkspace(outcomes, "experience outcome", errors);
  const artifactsById = new Map();
  for (const artifact of artifacts) {
    if (!artifact?.id) {
      errors.push("restored artifact identity missing");
      continue;
    }
    if (artifactsById.has(artifact.id)) errors.push(`restored artifact duplicate identity ${artifact.id}`);
    else artifactsById.set(artifact.id, artifact);
    if (!digest.test(artifact.contentDigest ?? "")) errors.push(`restored artifact content digest invalid ${artifact.id}`);
  }

  for (const snapshot of sourceSnapshots) {
    if (!snapshot.contentVersion) errors.push(`source provenance content version missing ${snapshot.id}`);
    if (snapshot.sourceKind === "git") {
      if (!snapshot.gitCommitSha || snapshot.attestation !== null || snapshot.linkedGitCommitSha !== null
        || !snapshot.remoteIdentityDigest) errors.push(`git source provenance incomplete ${snapshot.id}`);
    } else if (snapshot.sourceKind === "upload") {
      const linked = snapshot.attestation === "git_linked";
      if (snapshot.gitCommitSha !== null || !["unverified", "admin_attested", "git_linked"].includes(snapshot.attestation)
        || (linked && (!snapshot.linkedGitCommitSha || !snapshot.remoteIdentityDigest))
        || (!linked && (snapshot.linkedGitCommitSha !== null || snapshot.remoteIdentityDigest !== null))) {
        errors.push(`upload source provenance incomplete ${snapshot.id}`);
      }
    } else errors.push(`source provenance kind invalid ${snapshot.id}`);
  }

  const profileByDigest = new Map();
  for (const profile of projectProfiles) {
    const snapshot = snapshotsById.get(scoped(profile.workspaceId, profile.snapshotId));
    const artifact = artifactsById.get(profile.artifactId);
    if (!snapshot) errors.push(`project profile snapshot missing ${profile.artifactId}`);
    if (!artifact || artifact.kind !== "frontend-project-profile") {
      errors.push(`project profile artifact missing ${profile.artifactId}`);
    } else if (artifact.snapshotId !== profile.snapshotId
      || artifact.contentDigest !== profile.contentDigest
      || artifact.payloadDigest !== profile.profileDigest) {
      errors.push(`project profile artifact digest mismatch ${profile.artifactId}`);
    }
    if (!digest.test(profile.profileDigest ?? "")) errors.push(`project profile digest invalid ${profile.artifactId}`);
    profileByDigest.set(scoped(profile.workspaceId, profile.profileDigest), profile);
  }

  for (const release of releases) {
    if (!snapshotsById.has(scoped(release.workspaceId, release.snapshotId))) {
      errors.push(`release snapshot missing ${release.id}`);
    }
    if (release.projectProfileArtifactId) {
      const profile = projectProfiles.find((item) => item.workspaceId === release.workspaceId
        && item.artifactId === release.projectProfileArtifactId);
      if (!profile) errors.push(`release project profile link missing ${release.id}`);
    }
  }

  for (const item of evidence) {
    const group = groupsById.get(scoped(item.workspaceId, item.patternGroupId));
    const release = releasesById.get(scoped(item.workspaceId, item.releaseId));
    const snapshot = snapshotsById.get(scoped(item.workspaceId, item.snapshotId));
    if (!group) errors.push(`experience evidence pattern group missing ${item.id}`);
    if (!release) errors.push(`experience evidence release missing ${item.id}`);
    if (!snapshot) errors.push(`experience evidence snapshot missing ${item.id}`);
    if (release && (release.snapshotId !== item.snapshotId || release.workspaceId !== item.workspaceId)) {
      errors.push(`experience evidence release provenance mismatch ${item.id}`);
    }
    if (!profileByDigest.has(scoped(item.workspaceId, item.profileDigest))) {
      errors.push(`experience evidence project profile missing ${item.id}`);
    }
    if (snapshot && snapshot.contentVersion !== item.contentVersion) {
      errors.push(`experience evidence content version mismatch ${item.id}`);
    }
    if (!Array.isArray(item.citationSnapshotIds) || item.citationSnapshotIds.length === 0
      || item.citationSnapshotIds.some((snapshotId) => snapshotId !== item.snapshotId)) {
      errors.push(`experience evidence citation provenance mismatch ${item.id}`);
    }
  }

  const validateBasis = (item, label) => {
    if (!groupsById.has(scoped(item.workspaceId, item.patternGroupId))) {
      errors.push(`${label} pattern group missing ${item.id}`);
    }
    if (!Array.isArray(item.basisEvidenceIds)) {
      errors.push(`${label} basis invalid ${item.id}`);
      return;
    }
    for (const evidenceId of item.basisEvidenceIds) {
      const basis = evidenceById.get(scoped(item.workspaceId, evidenceId));
      if (!basis || basis.patternGroupId !== item.patternGroupId) {
        errors.push(`${label} basis evidence missing ${item.id}`);
      } else if (!releasesById.has(scoped(basis.workspaceId, basis.releaseId))) {
        errors.push(`${label} basis release missing ${item.id}`);
      }
    }
  };
  for (const item of decisions) validateBasis(item, "experience decision");

  for (const item of outcomes) {
    if (!groupsById.has(scoped(item.workspaceId, item.patternGroupId))) {
      errors.push(`experience outcome pattern group missing ${item.id}`);
    }
    if (item.evidenceId !== null) {
      const basis = evidenceById.get(scoped(item.workspaceId, item.evidenceId));
      if (!basis || basis.patternGroupId !== item.patternGroupId) {
        errors.push(`experience outcome evidence missing ${item.id}`);
      } else if (basis.contentVersion !== item.sourceVersion) {
        errors.push(`experience outcome source version mismatch ${item.id}`);
      }
    }
  }

  for (const item of reviews) {
    validateBasis(item, "experience review");
    if (item.decisionId !== null) {
      const decision = decisionsById.get(scoped(item.workspaceId, item.decisionId));
      if (!decision || decision.patternGroupId !== item.patternGroupId) {
        errors.push(`experience review decision missing ${item.id}`);
      }
    }
  }

  for (const item of reviewItems) {
    if (!groupsById.has(scoped(item.workspaceId, item.patternGroupId))) {
      errors.push(`experience review item pattern group missing ${item.id}`);
    }
    const basis = item.evidenceId === null ? null : evidenceById.get(scoped(item.workspaceId, item.evidenceId));
    const outcome = item.outcomeId === null ? null : outcomesById.get(scoped(item.workspaceId, item.outcomeId));
    if (item.evidenceId !== null && !basis) errors.push(`experience review item evidence missing ${item.id}`);
    if (item.outcomeId !== null && !outcome) errors.push(`experience review item outcome missing ${item.id}`);
    if (basis && basis.contentVersion !== item.sourceVersion) {
      errors.push(`experience review item source version mismatch ${item.id}`);
    }
  }

  checkSupersession(standards, "workspace standard", errors);
  for (const standard of standards) {
    if (!groupsById.has(scoped(standard.workspaceId, standard.patternGroupId))) {
      errors.push(`workspace standard pattern group missing ${standard.id}`);
    }
  }

  const counts = {
    sourceSnapshots: sourceSnapshots.length,
    releases: releases.length,
    projectProfiles: projectProfiles.length,
    patternGroups: patternGroups.length,
    evidence: evidence.length,
    decisions: decisions.length,
    outcomes: outcomes.length,
    reviews: reviews.length,
    reviewItems: reviewItems.length,
    standards: standards.length,
    artifacts: artifacts.length
  };
  return { ok: errors.length === 0, errors: [...new Set(errors)], counts };
}

export async function main(args = process.argv.slice(2)) {
  const [path] = args;
  if (!path) throw new Error("Usage: validate-experience-recovery.mjs <manifest.json>");
  const input = JSON.parse(await readFile(path, "utf8"));
  const result = validateExperienceRecoveryEvidence(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

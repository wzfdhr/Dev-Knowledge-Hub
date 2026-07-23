#!/usr/bin/env bash
set -euo pipefail

[[ "${DEVKH_CONTAINER_SMOKE:-}" == "true" ]] || {
  printf 'CI recovery fixture seeding requires DEVKH_CONTAINER_SMOKE=true\n' >&2
  exit 64
}
[[ "${COMPOSE_PROJECT_NAME:-}" =~ ^devkh-ci(-[a-z0-9]+)*$ ]] || {
  printf 'CI recovery fixture seeding requires an isolated CI Compose project named devkh-ci or devkh-ci-<suffix>\n' >&2
  exit 64
}

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
compose=(docker compose -f "$project_root/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME")

"${compose[@]}" exec -T postgres psql -U devkh -d dev_knowledge_hub -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
INSERT INTO workspaces (id, name, slug)
VALUES ('11111111-1111-4111-8111-111111111111', 'Recovery fixture', 'recovery-fixture');
INSERT INTO admin_users (id, workspace_id, email, password_hash)
VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'recovery@example.invalid', 'not-used-by-recovery');
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'admin');
INSERT INTO projects (id, workspace_id, name, slug)
VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Recovery project', 'recovery-project');
INSERT INTO project_members (project_id, user_id, role)
VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'admin');
INSERT INTO repositories (id, workspace_id, project_id, name, clone_url, default_branch)
VALUES ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'Recovery source', 'https://example.invalid/recovery.git', 'main');
INSERT INTO source_snapshots (
  id, workspace_id, repository_id, commit_sha, ref, storage_path,
  source_kind, git_commit_sha, content_version, attestation,
  linked_git_commit_sha, remote_identity_digest
)
VALUES (
  '55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111',
  '44444444-4444-4444-8444-444444444444', repeat('5', 40), 'refs/heads/main',
  '/var/lib/devkh/snapshots/snapshots/55555555-5555-4555-8555-555555555555/files',
  'git', repeat('5', 40), repeat('5', 40), NULL, NULL, repeat('e', 64)
);
INSERT INTO source_blobs (id, workspace_id, content_hash, generation, byte_size, status, storage_key)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
  '47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28', 1, 34, 'active',
  'blobs/11111111-1111-4111-8111-111111111111/47/47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28/1'
);
INSERT INTO source_blobs (id, workspace_id, content_hash, generation, byte_size, status, storage_key, deleted_at)
VALUES (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111',
  '47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28', 2, 34, 'deleted',
  'blobs/11111111-1111-4111-8111-111111111111/47/47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28/2', now()
);
INSERT INTO source_files (id, workspace_id, snapshot_id, path, language, content_hash, byte_size, source_blob_id)
VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', 'src/one.ts', 'typescript', '47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28', 34, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', 'src/two.ts', 'typescript', '47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28', 34, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
INSERT INTO build_jobs (id, workspace_id, repository_id, snapshot_id, status, snapshot_path, commit_sha)
VALUES ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', 'published', 'recovery/snapshot', repeat('5', 40));
INSERT INTO knowledge_artifacts (
  id, workspace_id, project_id, snapshot_id, build_job_id, stage, kind, schema_version,
  input_digest, content_digest, storage_key, source_refs, producer
)
VALUES (
  '77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333', '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666', 'synthesize', 'frontend-project-profile', 1,
  repeat('d', 64), '218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9',
  '33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/synthesize/218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9.json',
  '[]'::jsonb, 'deterministic'
);
INSERT INTO source_analysis_artifacts (
  workspace_id, content_hash, analyzer_id, analyzer_version, parser_config_digest, facts, facts_digest
)
VALUES (
  '11111111-1111-4111-8111-111111111111', repeat('a', 64), 'recovery-syntax', '1.0.0', repeat('b', 64),
  '{"schemaVersion":1,"declarations":[]}'::jsonb, repeat('c', 64)
);
INSERT INTO releases (id, workspace_id, repository_id, build_job_id, snapshot_id, version, published_at)
VALUES ('88888888-8888-4888-8888-888888888888', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', '66666666-6666-4666-8666-666666666666', '55555555-5555-4555-8555-555555555555', 'recovery-v1', now());
INSERT INTO workspace_pattern_groups (id, workspace_id, capability, state)
VALUES ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', '11111111-1111-4111-8111-111111111111', 'frontend_testing', 'recommended');
INSERT INTO workspace_pattern_evidence (
  id, workspace_id, pattern_group_id, project_id, release_id, snapshot_id,
  source_eligibility, title, observed_fact, profile_digest, content_version, citations
)
VALUES (
  'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2', '11111111-1111-4111-8111-111111111111',
  'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', '33333333-3333-4333-8333-333333333333',
  '88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555',
  'git', 'Recovery frontend test pattern', 'Observed cited frontend test implementation',
  repeat('d', 64), repeat('5', 40),
  '[{"snapshotId":"55555555-5555-4555-8555-555555555555","path":"src/one.ts","startLine":1,"endLine":1,"blobHash":"47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28"}]'::jsonb
);
INSERT INTO workspace_decisions (
  id, workspace_id, pattern_group_id, actor_id, decision, reason,
  basis_evidence_ids, applicability
)
VALUES (
  'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', '11111111-1111-4111-8111-111111111111',
  'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', '22222222-2222-4222-8222-222222222222',
  'approve', 'Recovery fixture approval',
  ARRAY['a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2']::uuid[],
  '{"required":[],"forbidden":[],"preferred":[],"unsupportedWhenUnknown":[]}'::jsonb
);
INSERT INTO workspace_outcomes (
  id, workspace_id, pattern_group_id, evidence_id, authority, outcome,
  source_version, checks, report_digest, recorded_by
)
VALUES (
  'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', '11111111-1111-4111-8111-111111111111',
  'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2',
  'signed_ci', 'failed', repeat('5', 40), '[{"name":"recovery","status":"failed"}]'::jsonb,
  repeat('f', 64), '22222222-2222-4222-8222-222222222222'
);
INSERT INTO workspace_experience_reviews (
  id, workspace_id, pattern_group_id, actor_id, from_state, to_state,
  reason, basis_evidence_ids, decision_id
)
VALUES (
  'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5', '11111111-1111-4111-8111-111111111111',
  'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', '22222222-2222-4222-8222-222222222222',
  'candidate', 'recommended', 'Recovery fixture review',
  ARRAY['a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2']::uuid[],
  'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3'
);
INSERT INTO workspace_standards (
  id, workspace_id, pattern_group_id, title, body, authored_by, superseded_by_id
)
VALUES (
  'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6', '11111111-1111-4111-8111-111111111111',
  'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'Recovery standard',
  'Preserved recovery standard', '22222222-2222-4222-8222-222222222222', NULL
);
INSERT INTO workspace_experience_review_items (
  id, workspace_id, pattern_group_id, evidence_id, outcome_id, reported_by,
  kind, priority, feedback_event, current_project_id, source_version, task_summary
)
VALUES (
  'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7', '11111111-1111-4111-8111-111111111111',
  'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2',
  'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', '22222222-2222-4222-8222-222222222222',
  'trusted_negative_outcome', 'high', NULL, NULL, repeat('5', 40), 'Recovery fixture review item'
);
INSERT INTO release_channels (id, workspace_id, repository_id, release_id, name)
VALUES ('99999999-9999-4999-8999-999999999999', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', '88888888-8888-4888-8888-888888888888', 'current');
COMMIT;
SQL

write_volume_file() {
  local volume="$1"
  local path="$2"
  local content="$3"
  docker run --rm \
    --mount "type=volume,src=$volume,dst=/data" \
    alpine:3.20 sh -c 'mkdir -p "$(dirname "$1")"; printf "%s\n" "$2" > "$1"' sh "/data/$path" "$content"
}

write_volume_file "${COMPOSE_PROJECT_NAME}_snapshot_data" recovery/snapshot.json '{"fixture":true}'
docker run --rm \
  --mount "type=volume,src=${COMPOSE_PROJECT_NAME}_snapshot_data,dst=/data" \
  alpine:3.20 sh -ceu '
    blob="/data/blobs/11111111-1111-4111-8111-111111111111/47/47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28/1"
    view="/data/snapshots/55555555-5555-4555-8555-555555555555/files/src"
    mkdir -p "$(dirname "$blob")" "$view"
    printf "export const recoveryFixture = 1;\\n" > "$blob"
    ln "$blob" "$view/one.ts"
    ln "$blob" "$view/two.ts"
    chmod 0444 "$blob"
  '
write_volume_file "${COMPOSE_PROJECT_NAME}_repository_mirrors" recovery/HEAD 'ref: refs/heads/main'
write_volume_file "${COMPOSE_PROJECT_NAME}_uploaded_sources" recovery/source.ts 'export const recoveryFixture = true;'
write_volume_file "${COMPOSE_PROJECT_NAME}_artifact_data" \
  33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/synthesize/218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9.json \
  '{"fixture":true}'

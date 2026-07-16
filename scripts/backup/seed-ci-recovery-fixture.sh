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
INSERT INTO source_snapshots (id, workspace_id, repository_id, commit_sha, ref, storage_path)
VALUES ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', repeat('5', 40), 'refs/heads/main', 'recovery/snapshot');
INSERT INTO build_jobs (id, workspace_id, repository_id, snapshot_id, status, snapshot_path, commit_sha)
VALUES ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', 'published', 'recovery/snapshot', repeat('5', 40));
INSERT INTO knowledge_artifacts (
  id, workspace_id, project_id, snapshot_id, build_job_id, stage, kind, schema_version,
  input_digest, content_digest, storage_key, source_refs, producer
)
VALUES (
  '77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333', '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666', 'convert', 'recovery-fixture', 1,
  repeat('d', 64), '218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9',
  '33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/convert/218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9.json',
  '[]'::jsonb, 'deterministic'
);
INSERT INTO releases (id, workspace_id, repository_id, build_job_id, snapshot_id, version, published_at)
VALUES ('88888888-8888-4888-8888-888888888888', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', '66666666-6666-4666-8666-666666666666', '55555555-5555-4555-8555-555555555555', 'recovery-v1', now());
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
write_volume_file "${COMPOSE_PROJECT_NAME}_repository_mirrors" recovery/HEAD 'ref: refs/heads/main'
write_volume_file "${COMPOSE_PROJECT_NAME}_uploaded_sources" recovery/source.ts 'export const recoveryFixture = true;'
write_volume_file "${COMPOSE_PROJECT_NAME}_artifact_data" \
  33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/convert/218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9.json \
  '{"fixture":true}'

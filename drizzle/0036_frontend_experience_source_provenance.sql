ALTER TABLE source_snapshots ADD COLUMN source_kind text;
ALTER TABLE source_snapshots ADD COLUMN git_commit_sha text;
ALTER TABLE source_snapshots ADD COLUMN content_version text;
ALTER TABLE source_snapshots ADD COLUMN attestation text;
ALTER TABLE source_snapshots ADD COLUMN linked_git_commit_sha text;
ALTER TABLE source_snapshots ADD COLUMN remote_identity_digest text;

UPDATE source_snapshots snapshot
SET source_kind = CASE WHEN repository.kind = 'upload' THEN 'upload' ELSE 'git' END,
    git_commit_sha = CASE WHEN repository.kind IN ('git', 'local') THEN snapshot.commit_sha ELSE NULL END,
    content_version = snapshot.commit_sha,
    attestation = CASE WHEN repository.kind = 'upload' THEN 'unverified' ELSE NULL END,
    linked_git_commit_sha = NULL,
    remote_identity_digest = CASE
      WHEN repository.kind IN ('git', 'local')
        THEN md5(COALESCE(snapshot.remote_url, repository.id::text))
      ELSE NULL
    END
FROM repositories repository
WHERE repository.id = snapshot.repository_id
  AND repository.workspace_id = snapshot.workspace_id;

ALTER TABLE source_snapshots ALTER COLUMN source_kind SET NOT NULL;
ALTER TABLE source_snapshots ALTER COLUMN content_version SET NOT NULL;

ALTER TABLE source_snapshots
  ADD CONSTRAINT source_snapshots_provenance_shape_check CHECK (
    (source_kind = 'git'
      AND git_commit_sha IS NOT NULL
      AND attestation IS NULL
      AND linked_git_commit_sha IS NULL
      AND remote_identity_digest IS NOT NULL)
    OR
    (source_kind = 'upload'
      AND git_commit_sha IS NULL
      AND attestation IN ('unverified', 'admin_attested', 'git_linked')
      AND (
        (attestation = 'git_linked'
          AND linked_git_commit_sha IS NOT NULL
          AND remote_identity_digest IS NOT NULL)
        OR
        (attestation <> 'git_linked'
          AND linked_git_commit_sha IS NULL
          AND remote_identity_digest IS NULL)
      ))
  );

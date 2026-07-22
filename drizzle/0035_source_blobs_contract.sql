DO $contract_authorization$
BEGIN
  IF current_setting('devkh.source_blob_contract_authorized', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'source blob contract migration is not authorized';
  END IF;
END
$contract_authorization$;

LOCK TABLE source_files, source_blobs IN SHARE ROW EXCLUSIVE MODE;

DO $contract_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM source_files WHERE source_blob_id IS NULL) THEN
    RAISE EXCEPTION 'source blob contract blocked: source files are missing source_blob_id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM source_files file
    JOIN source_blobs blob ON blob.id = file.source_blob_id
    WHERE blob.status <> 'active'
       OR blob.fencing_token IS NOT NULL
       OR blob.tombstoned_at IS NOT NULL
       OR blob.trashed_at IS NOT NULL
       OR blob.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'source blob contract blocked: referenced source blob is non-active or fenced';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM source_files file
    LEFT JOIN source_blobs blob ON blob.id = file.source_blob_id
    WHERE blob.id IS NULL
       OR blob.workspace_id <> file.workspace_id
       OR blob.content_hash <> file.content_hash
       OR blob.byte_size <> file.byte_size
       OR blob.generation < 1
       OR blob.status <> 'active'
       OR blob.fencing_token IS NOT NULL
       OR blob.tombstoned_at IS NOT NULL
       OR blob.trashed_at IS NOT NULL
       OR blob.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'source blob contract blocked: source file identity mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM source_blobs
    WHERE status = 'active'
    GROUP BY workspace_id, content_hash
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'source blob contract blocked: duplicate active source blob generation';
  END IF;
END
$contract_preflight$;

ALTER TABLE source_blobs
  ADD CONSTRAINT source_blobs_reference_identity_unique
  UNIQUE (id, workspace_id, content_hash, byte_size);

ALTER TABLE source_files
  DROP CONSTRAINT source_files_source_blob_workspace_fk;

ALTER TABLE source_files
  ADD CONSTRAINT source_files_source_blob_identity_fk
  FOREIGN KEY (source_blob_id, workspace_id, content_hash, byte_size)
  REFERENCES source_blobs(id, workspace_id, content_hash, byte_size)
  ON DELETE RESTRICT;

ALTER TABLE source_files
  ALTER COLUMN source_blob_id SET NOT NULL;

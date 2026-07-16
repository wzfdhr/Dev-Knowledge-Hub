CREATE OR REPLACE FUNCTION enforce_release_provenance_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kernel_mode IS DISTINCT FROM OLD.kernel_mode
    OR NEW.package_artifact_id IS DISTINCT FROM OLD.package_artifact_id THEN
    RAISE EXCEPTION 'Release pipeline provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER releases_pipeline_provenance_immutable
  BEFORE UPDATE OF kernel_mode, package_artifact_id ON releases
  FOR EACH ROW EXECUTE FUNCTION enforce_release_provenance_immutable();

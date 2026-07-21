import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const auditSql = String.raw`
BEGIN;
CREATE TEMP TABLE devkh_application_rows (table_name text PRIMARY KEY);
DO $audit$
DECLARE
  relation record;
  has_rows boolean;
BEGIN
  FOR relation IN
    SELECT namespace.nspname AS schema_name, class.relname AS table_name
    FROM pg_catalog.pg_class class
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE class.relkind IN ('r', 'p')
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname !~ '^pg_toast'
      AND NOT (namespace.nspname = 'public' AND class.relname = 'schema_migrations')
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)', relation.schema_name, relation.table_name)
      INTO has_rows;
    IF has_rows THEN
      INSERT INTO devkh_application_rows VALUES (relation.schema_name || '.' || relation.table_name);
    END IF;
  END LOOP;
END
$audit$;
SELECT json_build_object(
  'applicationDataTables', COALESCE((SELECT json_agg(table_name ORDER BY table_name) FROM devkh_application_rows), '[]'::json),
  'ledger', COALESCE((SELECT json_agg(name ORDER BY name) FROM public.schema_migrations), '[]'::json),
  'sourceBlobNotNull', COALESCE((
    SELECT attribute.attnotnull
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = 'public.source_files'::regclass
      AND attribute.attname = 'source_blob_id'
      AND NOT attribute.attisdropped
  ), false),
  'identityUnique', EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.source_blobs'::regclass
      AND conname = 'source_blobs_reference_identity_unique'
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (id, workspace_id, content_hash, byte_size)'
  ),
  'identityForeignKey', EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.source_files'::regclass
      AND conname = 'source_files_source_blob_identity_fk'
      AND contype = 'f'
      AND pg_get_constraintdef(oid) = 'FOREIGN KEY (source_blob_id, workspace_id, content_hash, byte_size) REFERENCES source_blobs(id, workspace_id, content_hash, byte_size) ON DELETE RESTRICT'
  )
)::text;
ROLLBACK;
`;

function validateExpectedMigrations(expectedMigrations) {
  if (!Array.isArray(expectedMigrations) || expectedMigrations.length === 0
    || expectedMigrations.at(-1) !== "0035_source_blobs_contract.sql"
    || expectedMigrations.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error("Post-contract runtime baseline migration ledger expectation is invalid");
  }
}

function splitSqlStatements(sql) {
  if (typeof sql !== "string") throw new Error("Post-contract runtime baseline SQL is invalid");
  const statements = [];
  let current = "";
  let lineStart = true;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        current += "\n";
        lineStart = true;
      }
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
      } else if (char === "\n") {
        current += "\n";
        lineStart = true;
      }
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += char;
      }
      lineStart = char === "\n";
      continue;
    }
    if (singleQuoted) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      lineStart = char === "\n";
      continue;
    }
    if (doubleQuoted) {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      lineStart = char === "\n";
      continue;
    }
    if (lineStart && char === "\\") {
      if (current.trim()) throw new Error("Post-contract runtime baseline has an embedded psql command");
      const end = sql.indexOf("\n", index);
      statements.push(sql.slice(index, end < 0 ? sql.length : end).trim());
      index = end < 0 ? sql.length : end;
      current = "";
      lineStart = true;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      current += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 1;
      current += " ";
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      current += char;
    } else if (char === '"') {
      doubleQuoted = true;
      current += char;
    } else if (char === "$") {
      const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        dollarTag = tag;
        current += tag;
        index += tag.length - 1;
      } else {
        current += char;
      }
    } else if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else {
      current += char;
    }
    lineStart = char === "\n" || (lineStart && /[\t\r ]/.test(char));
  }
  if (singleQuoted || doubleQuoted || dollarTag !== null || blockCommentDepth > 0) {
    throw new Error("Post-contract runtime baseline has an unterminated SQL construct");
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function validatePostContractBaselineGrammar(sql, expectedMigrations) {
  validateExpectedMigrations(expectedMigrations);
  const allowedSetStatements = new Set([
    "SET statement_timeout = 0", "SET lock_timeout = 0", "SET idle_in_transaction_session_timeout = 0",
    "SET client_encoding = 'UTF8'", "SET standard_conforming_strings = on",
    "SET check_function_bodies = false", "SET xmloption = content",
    "SET client_min_messages = warning", "SET row_security = off",
    "SET default_tablespace = ''", "SET default_table_access_method = heap"
  ]);
  const ledger = [];
  for (const statement of splitSqlStatements(sql)) {
    const compact = statement.replace(/\s+/g, " ").trim();
    const ledgerMatch = compact.match(/^INSERT INTO public\.schema_migrations \(name, applied_at\) VALUES \('([^']+)', '(?:[^']|'')+'\)$/);
    if (ledgerMatch) {
      ledger.push(ledgerMatch[1]);
      continue;
    }
    const allowed = /^\\(?:un)?restrict [A-Za-z0-9]+$/.test(compact)
      || allowedSetStatements.has(compact)
      || compact === "SELECT pg_catalog.set_config('search_path', '', false)"
      || /^CREATE EXTENSION IF NOT EXISTS (?:pg_trgm|pgcrypto) WITH SCHEMA public$/.test(compact)
      || /^COMMENT ON EXTENSION (?:pg_trgm|pgcrypto) IS '[^']*'$/.test(compact)
      || /^CREATE TYPE public\.[a-z0-9_]+ AS ENUM \(/.test(compact)
      || /^CREATE FUNCTION public\.[a-z0-9_]+\(/.test(compact)
      || /^CREATE TABLE public\.[a-z0-9_]+ \(/.test(compact)
      || /^CREATE SEQUENCE public\.[a-z0-9_]+(?: |$)/.test(compact)
      || /^CREATE (?:UNIQUE )?INDEX [a-z0-9_]+ ON public\.[a-z0-9_]+ /.test(compact)
      || /^CREATE TRIGGER [a-z0-9_]+ .+ ON public\.[a-z0-9_]+ /.test(compact)
      || /^ALTER TABLE (?:ONLY )?public\.[a-z0-9_]+ /.test(compact)
      || /^ALTER SEQUENCE public\.[a-z0-9_]+ /.test(compact);
    if (!allowed) {
      throw new Error(`Post-contract runtime baseline contains a forbidden executable statement: ${compact.slice(0, 80)}`);
    }
  }
  if (JSON.stringify(ledger) !== JSON.stringify(expectedMigrations)) {
    throw new Error("Post-contract runtime baseline migration ledger is incomplete or unexpected");
  }
}

export function assertPostContractDatabaseAudit(audit, expectedMigrations) {
  validateExpectedMigrations(expectedMigrations);
  if (!audit || Object.keys(audit).sort().join(",")
    !== ["applicationDataTables", "identityForeignKey", "identityUnique", "ledger", "sourceBlobNotNull"].sort().join(",")) {
    throw new Error("Post-contract runtime database audit result is invalid");
  }
  if (!Array.isArray(audit.applicationDataTables) || audit.applicationDataTables.length > 0) {
    throw new Error(`Post-contract runtime baseline contains application data: ${audit.applicationDataTables?.join(", ") ?? "invalid audit"}`);
  }
  if (JSON.stringify(audit.ledger) !== JSON.stringify(expectedMigrations)) {
    throw new Error(`Post-contract runtime baseline migration ledger is incomplete or unexpected: expected ${JSON.stringify(expectedMigrations)}, received ${JSON.stringify(audit.ledger)}`);
  }
  if (audit.sourceBlobNotNull !== true || audit.identityUnique !== true || audit.identityForeignKey !== true) {
    throw new Error("Post-contract runtime baseline does not enforce the source blob schema contract");
  }
}

function waitForCompletedInitialization(containerId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const logs = spawnSync("docker", ["logs", containerId], { encoding: "utf8" });
    const ready = spawnSync("docker", [
      "exec", containerId, "pg_isready", "-U", "devkh", "-d", "dev_knowledge_hub"
    ], { stdio: "ignore" });
    if (`${logs.stdout}${logs.stderr}`.includes("PostgreSQL init process complete; ready for start up.")
      && ready.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
  throw new Error("Post-contract runtime PostgreSQL did not complete trusted baseline initialization");
}

export async function verifyPostContractDatabase({ containerId, expectedMigrations }) {
  validateExpectedMigrations(expectedMigrations);
  if (!/^[A-Za-z0-9_.-]+$/.test(containerId ?? "")) {
    throw new Error("Post-contract runtime PostgreSQL container identity is invalid");
  }
  waitForCompletedInitialization(containerId);
  const result = spawnSync("docker", [
    "exec", "-i", containerId,
    "psql", "-X", "-q", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
    "--tuples-only", "--no-align", "-U", "devkh", "-d", "dev_knowledge_hub"
  ], { input: auditSql, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Post-contract runtime database audit failed: ${result.stderr.trim()}`);
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error("Post-contract runtime database audit returned an invalid result");
  let audit;
  try {
    audit = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error("Post-contract runtime database audit did not return JSON", { cause: error });
  }
  assertPostContractDatabaseAudit(audit, expectedMigrations);
}

async function main() {
  let expectedMigrations;
  try {
    expectedMigrations = JSON.parse(process.env.DEVKH_POST_CONTRACT_EXPECTED_MIGRATIONS ?? "");
  } catch (error) {
    throw new Error("DEVKH_POST_CONTRACT_EXPECTED_MIGRATIONS is invalid", { cause: error });
  }
  const compose = [
    "compose", "-f", resolve(repositoryRoot, "docker-compose.yml"),
    "-f", resolve(repositoryRoot, "docker-compose.post-contract-ci.yml")
  ];
  const containerId = execFileSync("docker", [...compose, "ps", "-q", "postgres"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  }).trim();
  await verifyPostContractDatabase({ containerId, expectedMigrations });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "./artifact-store";
import { type ArtifactManifest } from "./contracts";
import {
  createNormalizedSourcesStageExecutor,
  normalizedSourcesPipelineInputDigest
} from "./convert-stage";
import {
  createTableSchemasStageExecutor,
  tableSchemasPipelineInputDigest,
  type TableSchemasStageStore
} from "./tables-stage";
import type { PipelineStageRunRecord } from "../../persistence/store";
import { MemoryAppStore } from "../../persistence/memory-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function crc32(content: Buffer): number {
  let value = 0xffffffff;
  for (const byte of content) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries: readonly { path: string; content: string }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + content.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function workbook(): Buffer {
  return storedZip([
    { path: "xl/workbook.xml", content: '<workbook xmlns:r="r"><sheets><sheet name="Usage" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { path: "xl/_rels/workbook.xml.rels", content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { path: "xl/worksheets/sheet1.xml", content: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>email</t></is></c><c r="B1" t="inlineStr"><is><t>formula</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>ada@example.com</t></is></c><c r="B2"><f>SUM(1,2)</f></c></row></sheetData></worksheet>' }
  ]);
}

async function fixture(files: Record<string, string | Buffer>) {
  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-tables-stage-snapshot-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-tables-stage-artifacts-"));
  directories.push(snapshotRoot, artifactRoot);
  await Promise.all(Object.entries(files).map(async ([filePath, content]) => {
    await mkdir(path.join(snapshotRoot, path.dirname(filePath)), { recursive: true });
    await writeFile(path.join(snapshotRoot, filePath), content);
  }));

  const store = new MemoryAppStore();
  const setup = await store.createInitialSetup("admin@example.com", "hash");
  const workspaceId = setup!.workspace.id;
  const project = (await store.listProjects(workspaceId))[0]!;
  const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
  const snapshot = await store.createSnapshot({
    snapshot: {
      id: "snapshot-1", workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
      ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: snapshotRoot
    },
    files: Object.entries(files).map(([filePath, content]) => ({
      id: randomUUID(), workspaceId, snapshotId: "snapshot-1", path: filePath,
      byteSize: Buffer.byteLength(content), contentHash: hash(content), language: null
    }))
  });
  const { build } = await store.createBuild({
    workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
    snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
  });
  const snapshotFiles = await store.listSnapshotFiles(workspaceId, snapshot.id);
  const artifactStore = new ArtifactStore(artifactRoot, store);
  await artifactStore.initialize();
  const convertRun: PipelineStageRunRecord = {
    id: "convert-run", workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
    stage: "convert", attempt: 1, status: "running",
    inputDigest: normalizedSourcesPipelineInputDigest(snapshot, snapshotFiles, build.purpose), outputManifestIds: [],
    startedAt: "2026-07-16T00:00:00.000Z", finishedAt: null, errorCode: null, errorDetail: null
  };
  const convert = await createNormalizedSourcesStageExecutor({ store, artifactStore })(convertRun);
  const manifest = store.knowledgeArtifacts.find((artifact) => artifact.id === convert.outputManifestIds![0])!;
  const tablesRun: PipelineStageRunRecord = {
    ...convertRun,
    id: "tables-run",
    stage: "tables",
    outputManifestIds: ["tables-output-manifest"],
    inputDigest: tableSchemasPipelineInputDigest(snapshot, build.purpose, convert.outputManifestIds!)
  };
  const completedConvertRun: PipelineStageRunRecord = {
    ...convertRun,
    status: "reused",
    outputManifestIds: convert.outputManifestIds!,
    finishedAt: "2026-07-16T00:00:01.000Z"
  };

  return { artifactStore, build, completedConvertRun, manifest, project, repository: repository!, snapshot, store, tablesRun };
}

function stageStore(
  prepared: Awaited<ReturnType<typeof fixture>>,
  manifests: Map<string, ArtifactManifest>,
  stageRuns: readonly PipelineStageRunRecord[]
): TableSchemasStageStore {
  Object.assign(prepared.store, {
    findArtifactById: async (artifactId: string) => manifests.get(artifactId) ?? null,
    listPipelineStageRuns: async () => stageRuns
  });
  return prepared.store as unknown as TableSchemasStageStore;
}

describe("table schemas pipeline stage", () => {
  test("writes CSV and XLSX schemas with redacted samples and formula text", async () => {
    const prepared = await fixture({
      "src/app.ts": "export const answer = 42;\n",
      "data/users.csv": "email,phone,formula\nada@example.com,15551234567,\"=SUM(1,2)\"\n",
      "data/usage.xlsx": workbook()
    });
    const execute = createTableSchemasStageExecutor({
      store: stageStore(prepared, new Map([[prepared.manifest.id, prepared.manifest]]), [prepared.completedConvertRun]),
      artifactStore: prepared.artifactStore
    });

    const result = await execute(prepared.tablesRun);

    expect(result).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    const artifact = prepared.store.knowledgeArtifacts.find((candidate) => candidate.id === result.outputManifestIds![0])!;
    expect(artifact).toMatchObject({ stage: "tables", kind: "table-schemas", producer: "deterministic" });
    await expect(prepared.artifactStore.getJson(artifact)).resolves.toEqual({
      schemaVersion: 1,
      snapshotId: prepared.snapshot.id,
      tables: expect.arrayContaining([
        expect.objectContaining({ sourcePath: "data/users.csv", rowCount: 1 }),
        expect.objectContaining({ sourcePath: "data/usage.xlsx", sheet: "Usage", rowCount: 1 })
      ]),
      samples: expect.arrayContaining([
        expect.objectContaining({ tableId: expect.any(String), rows: [["[redacted-email]", "[redacted]", "=SUM(1,2)"]] }),
        expect.objectContaining({ tableId: expect.any(String), rows: [["[redacted-email]", "=SUM(1,2)"]] })
      ])
    });
    const users = (await prepared.artifactStore.getJson(artifact) as { tables: Array<{ sourcePath: string; columns: unknown[] }> }).tables
      .find((table) => table.sourcePath === "data/users.csv")!;
    expect(users.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "email", sensitive: true }),
      expect.objectContaining({ name: "phone", sensitive: true }),
      expect.objectContaining({ name: "formula", formulaLike: true })
    ]));
  });

  test("reuses the deterministic artifact for the same upstream manifest and snapshot files", async () => {
    const prepared = await fixture({ "src/app.ts": "export const answer = 42;\n", "data/users.csv": "name\nAda\n" });
    const execute = createTableSchemasStageExecutor({
      store: stageStore(prepared, new Map([[prepared.manifest.id, prepared.manifest]]), [prepared.completedConvertRun]),
      artifactStore: prepared.artifactStore
    });

    const first = await execute(prepared.tablesRun);
    const second = await execute(prepared.tablesRun);

    expect(first).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    expect(second).toEqual({ outputManifestIds: first.outputManifestIds, reused: true });
  });

  test("rejects cross-project runs and input digests that do not represent the persisted convert run", async () => {
    const prepared = await fixture({ "src/app.ts": "export const answer = 42;\n", "data/users.csv": "name\nAda\n" });
    const execute = createTableSchemasStageExecutor({
      store: stageStore(prepared, new Map([[prepared.manifest.id, prepared.manifest]]), [prepared.completedConvertRun]),
      artifactStore: prepared.artifactStore
    });

    await expect(execute({ ...prepared.tablesRun, projectId: "other-project" }))
      .rejects.toThrow("does not match the project build and snapshot");
    await expect(execute({ ...prepared.tablesRun, inputDigest: "0".repeat(64) }))
      .rejects.toThrow("input digest does not match the persisted upstream manifests");
  });
});

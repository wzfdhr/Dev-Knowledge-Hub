import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";

import { filterImportFile } from "../../shared/import-filter";

export const MAX_FOLDER_IMPORT_FILES = 50_000;
export const MAX_FOLDER_IMPORT_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FOLDER_IMPORT_ARCHIVE_BYTES = 500 * 1024 * 1024;

export interface DirectoryFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

export interface DirectoryDirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirectoryHandle>;
}

export type DirectoryHandle = DirectoryFileHandle | DirectoryDirectoryHandle;

export interface FolderImportFile {
  path: string;
  file: File;
}

export interface FolderImportReport {
  totalFiles: number;
  acceptedFiles: FolderImportFile[];
  acceptedBytes: number;
  ignored: { total: number; reasons: Record<string, number> };
}

export class FolderImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderImportError";
  }
}

function createReport(): FolderImportReport {
  return {
    totalFiles: 0,
    acceptedFiles: [],
    acceptedBytes: 0,
    ignored: { total: 0, reasons: {} }
  };
}

function ignore(report: FolderImportReport, reason: string): void {
  report.ignored.total += 1;
  report.ignored.reasons[reason] = (report.ignored.reasons[reason] ?? 0) + 1;
}

async function addFile(report: FolderImportReport, path: string, file: File): Promise<void> {
  report.totalFiles += 1;
  if (report.totalFiles > MAX_FOLDER_IMPORT_FILES) {
    throw new FolderImportError("项目包含的文件超过 50,000 个，无法导入");
  }

  const preliminary = filterImportFile({ path, byteSize: file.size });
  if (!preliminary.accepted) {
    ignore(report, preliminary.reason);
    return;
  }

  const content = new Uint8Array(await file.arrayBuffer());
  const decision = filterImportFile({ path, byteSize: file.size, content });
  if (!decision.accepted) {
    ignore(report, decision.reason);
    return;
  }

  report.acceptedBytes += file.size;
  if (report.acceptedBytes > MAX_FOLDER_IMPORT_EXPANDED_BYTES) {
    throw new FolderImportError("可采集文件超过 2 GiB，无法导入");
  }
  report.acceptedFiles.push({ path, file });
}

async function walkDirectory(handle: DirectoryDirectoryHandle, prefix: string, report: FolderImportReport): Promise<void> {
  for await (const entry of handle.values()) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      await walkDirectory(entry, entryPath, report);
    } else {
      await addFile(report, entryPath, await entry.getFile());
    }
  }
}

export async function scanDirectory(handle: DirectoryDirectoryHandle): Promise<FolderImportReport> {
  const report = createReport();
  await walkDirectory(handle, "", report);
  return report;
}

function relativePath(file: File): string {
  const browserPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (!browserPath) return file.name;
  const segments = browserPath.split("/").filter(Boolean);
  return segments.length > 1 ? segments.slice(1).join("/") : file.name;
}

export async function scanSelectedFiles(files: Iterable<File>): Promise<FolderImportReport> {
  const report = createReport();
  for (const file of files) {
    await addFile(report, relativePath(file), file);
  }
  return report;
}

export async function packageFolderImport(report: FolderImportReport): Promise<File> {
  if (report.acceptedFiles.length === 0) {
    throw new FolderImportError("没有可采集的源码或文档，请选择另一个项目文件夹");
  }
  const writer = new BlobWriter("application/zip");
  const archive = new ZipWriter(writer);
  for (const item of report.acceptedFiles) {
    await archive.add(item.path, new BlobReader(item.file));
  }
  await archive.close();
  const zip = await writer.getData();
  if (zip.size > MAX_FOLDER_IMPORT_ARCHIVE_BYTES) {
    throw new FolderImportError("过滤后的项目包超过 500 MiB，请拆分项目后重试");
  }
  return new File([zip], "devkh-filtered-project.zip", { type: "application/zip" });
}

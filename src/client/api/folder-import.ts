import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";

import { filterImportFile } from "../../shared/import-filter";
import type { ImportProgress } from "./types";

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

export interface FolderImportOptions {
  onProgress?(progress: ImportProgress): void;
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

async function addFile(
  report: FolderImportReport,
  path: string,
  file: File,
  options: FolderImportOptions
): Promise<void> {
  report.totalFiles += 1;
  options.onProgress?.({
    phase: "reading",
    status: "running",
    percent: 0,
    processedFiles: report.totalFiles,
    totalFiles: report.totalFiles,
    detail: `正在读取 ${path}`
  });
  if (report.totalFiles > MAX_FOLDER_IMPORT_FILES) {
    throw new FolderImportError("项目包含的文件超过 50,000 个，无法导入");
  }

  const preliminary = filterImportFile({ path, byteSize: file.size });
  if (!preliminary.accepted) {
    ignore(report, preliminary.reason);
    options.onProgress?.({
      phase: "filtering", status: "running", percent: 0,
      processedFiles: report.totalFiles, totalFiles: report.totalFiles,
      detail: `已过滤 ${path}`
    });
    return;
  }

  const content = new Uint8Array(await file.arrayBuffer());
  const decision = filterImportFile({ path, byteSize: file.size, content });
  if (!decision.accepted) {
    ignore(report, decision.reason);
    options.onProgress?.({
      phase: "filtering", status: "running", percent: 0,
      processedFiles: report.totalFiles, totalFiles: report.totalFiles,
      detail: `已过滤 ${path}`
    });
    return;
  }

  report.acceptedBytes += file.size;
  if (report.acceptedBytes > MAX_FOLDER_IMPORT_EXPANDED_BYTES) {
    throw new FolderImportError("可采集文件超过 2 GiB，无法导入");
  }
  report.acceptedFiles.push({ path, file });
  options.onProgress?.({
    phase: "filtering", status: "running", percent: 0,
    processedFiles: report.totalFiles, totalFiles: report.totalFiles,
    processedBytes: report.acceptedBytes,
    detail: `已采集 ${path}`
  });
}

async function walkDirectory(
  handle: DirectoryDirectoryHandle,
  prefix: string,
  report: FolderImportReport,
  options: FolderImportOptions
): Promise<void> {
  for await (const entry of handle.values()) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      await walkDirectory(entry, entryPath, report, options);
    } else {
      await addFile(report, entryPath, await entry.getFile(), options);
    }
  }
}

export async function scanDirectory(
  handle: DirectoryDirectoryHandle,
  options: FolderImportOptions = {}
): Promise<FolderImportReport> {
  const report = createReport();
  options.onProgress?.({
    phase: "reading", status: "running", percent: 0,
    processedFiles: 0, totalFiles: 0, detail: "正在读取项目文件夹"
  });
  await walkDirectory(handle, "", report, options);
  options.onProgress?.({
    phase: "filtering", status: "completed", percent: 100,
    processedFiles: report.totalFiles, totalFiles: report.totalFiles,
    processedBytes: report.acceptedBytes,
    detail: `已完成过滤，准备上传 ${report.acceptedFiles.length} 个文件`
  });
  return report;
}

function relativePath(file: File): string {
  const browserPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (!browserPath) return file.name;
  const segments = browserPath.split("/").filter(Boolean);
  return segments.length > 1 ? segments.slice(1).join("/") : file.name;
}

export async function scanSelectedFiles(
  files: Iterable<File>,
  options: FolderImportOptions = {}
): Promise<FolderImportReport> {
  const report = createReport();
  options.onProgress?.({
    phase: "reading", status: "running", percent: 0,
    processedFiles: 0, totalFiles: 0, detail: "正在读取项目文件夹"
  });
  for (const file of files) {
    await addFile(report, relativePath(file), file, options);
  }
  options.onProgress?.({
    phase: "filtering", status: "completed", percent: 100,
    processedFiles: report.totalFiles, totalFiles: report.totalFiles,
    processedBytes: report.acceptedBytes,
    detail: `已完成过滤，准备上传 ${report.acceptedFiles.length} 个文件`
  });
  return report;
}

export async function packageFolderImport(
  report: FolderImportReport,
  options: FolderImportOptions = {}
): Promise<File> {
  if (report.acceptedFiles.length === 0) {
    throw new FolderImportError("没有可采集的源码或文档，请选择另一个项目文件夹");
  }
  const writer = new BlobWriter("application/zip");
  const archive = new ZipWriter(writer);
  let completedBytes = 0;
  for (const [index, item] of report.acceptedFiles.entries()) {
    await archive.add(item.path, new BlobReader(item.file), {
      onprogress: (processedBytes) => options.onProgress?.({
        phase: "packaging", status: "running",
        percent: report.acceptedBytes ? Math.round(((completedBytes + processedBytes) / report.acceptedBytes) * 100) : 0,
        processedFiles: index, totalFiles: report.acceptedFiles.length,
        processedBytes: completedBytes + processedBytes, totalBytes: report.acceptedBytes,
        detail: `正在压缩 ${item.path}`
      })
    });
    completedBytes += item.file.size;
  }
  await archive.close();
  const zip = await writer.getData();
  if (zip.size > MAX_FOLDER_IMPORT_ARCHIVE_BYTES) {
    throw new FolderImportError("过滤后的项目包超过 500 MiB，请拆分项目后重试");
  }
  options.onProgress?.({
    phase: "packaging", status: "completed", percent: 100,
    processedFiles: report.acceptedFiles.length, totalFiles: report.acceptedFiles.length,
    processedBytes: report.acceptedBytes, totalBytes: report.acceptedBytes,
    detail: "项目包已准备完成"
  });
  return new File([zip], "devkh-filtered-project.zip", { type: "application/zip" });
}

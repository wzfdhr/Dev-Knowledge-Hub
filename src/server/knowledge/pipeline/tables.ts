import { createHash } from "node:crypto";
import path from "node:path";

import * as yauzl from "yauzl";

import type { SourceRef, TableSchema } from "../../../shared/api-contracts.js";

export const MAX_TABLE_ROWS = 100_000;
export const MAX_TABLE_COLUMNS = 256;
export const MAX_TABLE_SAMPLE_ROWS = 20;
export const MAX_XLSX_COMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_XLSX_EXPANDED_BYTES = 200 * 1024 * 1024;
export const MAX_XLSX_EXTRACTION_MS = 30_000;

export interface TableSourceInput {
  snapshotId: string;
  path: string;
  content: string;
  blobHash: string;
}

export interface TableExtractionResult {
  table: TableSchema;
  sample: string[][];
}

export interface XlsxTableSourceInput {
  snapshotId: string;
  path: string;
  content: Uint8Array;
  blobHash: string;
}

interface TableReferenceInput {
  snapshotId: string;
  path: string;
  blobHash: string;
  lineCount: number;
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [[]];
  let value = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted && character === '"' && content[index + 1] === '"') { value += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === ",") { rows.at(-1)!.push(value); value = ""; continue; }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      rows.at(-1)!.push(value); value = ""; rows.push([]); continue;
    }
    value += character;
  }
  if (value || rows.at(-1)!.length) rows.at(-1)!.push(value);
  else rows.pop();
  if (quoted) throw new Error("CSV contains an unterminated quoted cell");
  return rows;
}

function ref(input: TableReferenceInput): SourceRef {
  return { snapshotId: input.snapshotId, path: input.path, startLine: 1, endLine: Math.max(1, input.lineCount), blobHash: input.blobHash };
}

function sensitive(name: string): boolean { return /email|e-mail|phone|mobile|token|secret|password|身份证|手机号/i.test(name); }
function type(values: string[]): "string" | "number" | "boolean" | "date" | "unknown" {
  const nonEmpty = values.filter(Boolean);
  if (!nonEmpty.length) return "unknown";
  if (nonEmpty.every((value) => /^(true|false)$/i.test(value))) return "boolean";
  if (nonEmpty.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return "number";
  if (nonEmpty.every((value) => /^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(value))) return "date";
  return "string";
}

function redact(value: string, column: string): string {
  if (sensitive(column) && /@/.test(value)) return "[redacted-email]";
  if (sensitive(column)) return "[redacted]";
  return value;
}

function tableFromRows(input: TableReferenceInput, rows: string[][], sheet?: string): TableExtractionResult {
  const [header = [], ...data] = rows;
  if (header.length > MAX_TABLE_COLUMNS) throw new Error("Table exceeds 256 columns");
  if (data.length > MAX_TABLE_ROWS) throw new Error("Table exceeds 100000 rows");
  const sourceRef = ref(input);
  const columns = header.map((name, index) => {
    const values = data.map((row) => row[index] ?? "");
    return {
      name: name || `column_${index + 1}`, type: type(values), nullable: values.some((value) => !value),
      sensitive: sensitive(name), formulaLike: values.some((value) => /^[=+\-@]/.test(value)), sourceRefs: [sourceRef]
    };
  });
  return {
    table: {
      id: createHash("sha256").update(`${input.path}:${input.blobHash}:${sheet ?? ""}`).digest("hex"),
      name: input.path.split("/").at(-1)?.replace(/\.(?:csv|xlsx)$/i, "") || input.path,
      sourcePath: input.path, ...(sheet ? { sheet } : {}), columns, rowCount: data.length, candidate: false, sourceRefs: [sourceRef]
    },
    sample: data.slice(0, MAX_TABLE_SAMPLE_ROWS).map((row) => header.map((name, index) => redact(row[index] ?? "", name)))
  };
}

export function extractCsvTable(input: TableSourceInput): TableExtractionResult {
  const rows = parseCsv(input.content);
  return tableFromRows({ ...input, lineCount: input.content.split(/\r?\n/).length }, rows);
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";
    const number = entity.slice(2, -1);
    const codePoint = number.startsWith("x") || number.startsWith("X") ? Number.parseInt(number.slice(1), 16) : Number.parseInt(number, 10);
    return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
  });
}

function attribute(source: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(source);
  return match?.[1] ?? match?.[2];
}

function xmlText(source: string): string {
  return [...source.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join("");
}

function columnIndex(cellReference: string | undefined, fallback: number): number {
  const letters = cellReference?.match(/^[A-Z]+/i)?.[0];
  if (!letters) return fallback;
  return [...letters.toUpperCase()].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function cellValue(attributes: string, content: string, sharedStrings: readonly string[]): string {
  const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(content)?.[1];
  if (formula !== undefined) return `=${decodeXml(formula)}`;
  const kind = attribute(attributes, "t");
  if (kind === "inlineStr") return xmlText(content);
  const rawValue = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(content)?.[1] ?? "";
  if (kind === "s") return sharedStrings[Number.parseInt(rawValue, 10)] ?? "";
  if (kind === "b") return rawValue === "1" ? "true" : "false";
  return decodeXml(rawValue);
}

function rowsFromSheet(source: string, sharedStrings: readonly string[], deadline: number): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of source.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (Date.now() > deadline) throw new Error("XLSX extraction exceeded 30 seconds");
    if (rows.length >= MAX_TABLE_ROWS + 1) throw new Error("XLSX exceeds 100000 rows");
    const row: string[] = [];
    let fallback = 0;
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const index = columnIndex(attribute(cellMatch[1], "r"), fallback);
      if (index >= MAX_TABLE_COLUMNS) throw new Error("XLSX exceeds 256 columns");
      row[index] = cellValue(cellMatch[1], cellMatch[2], sharedStrings);
      fallback = index + 1;
    }
    rows.push(row);
  }
  return rows;
}

function hasActiveXlsxPath(filePath: string): boolean {
  return /^(?:xl\/(?:externalLinks|embeddings|activeX|macrosheets)\/|xl\/vbaProject[^/]*$)/i.test(filePath);
}

function shouldReadXlsxEntry(filePath: string): boolean {
  return filePath === "xl/workbook.xml"
    || filePath === "xl/sharedStrings.xml"
    || filePath === "xl/_rels/workbook.xml.rels"
    || /^xl\/worksheets\/[^/]+\.xml$/i.test(filePath)
    || /\.rels$/i.test(filePath);
}

async function readZipEntries(content: Uint8Array, deadline: number): Promise<Map<string, string>> {
  if (content.byteLength > MAX_XLSX_COMPRESSED_BYTES) throw new Error("XLSX exceeds 50 MiB compressed size");
  const archive = await yauzl.fromBufferPromise(Buffer.from(content), { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  const files = new Map<string, string>();
  let expandedBytes = 0;
  try {
    for await (const entry of archive.eachEntry()) {
      if (Date.now() > deadline) throw new Error("XLSX extraction exceeded 30 seconds");
      if (entry.fileName.endsWith("/")) continue;
      if (hasActiveXlsxPath(entry.fileName) || entry.isEncrypted()) throw new Error("XLSX contains active or external content");
      expandedBytes += entry.uncompressedSize;
      if (expandedBytes > MAX_XLSX_EXPANDED_BYTES) throw new Error("XLSX exceeds 200 MiB expanded size");
      if (!shouldReadXlsxEntry(entry.fileName)) continue;
      const stream = await archive.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        if (Date.now() > deadline) throw new Error("XLSX extraction exceeded 30 seconds");
        size += Buffer.byteLength(chunk);
        if (size > entry.uncompressedSize || size > MAX_XLSX_EXPANDED_BYTES) throw new Error("XLSX entry exceeds its declared size");
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (/TargetMode\s*=\s*(?:"External"|'External')|<externalLink\b/i.test(text)) throw new Error("XLSX contains active or external content");
      files.set(entry.fileName, text);
    }
  } finally {
    archive.close();
  }
  return files;
}

function sheetNames(files: ReadonlyMap<string, string>): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of files.get("xl/_rels/workbook.xml.rels")?.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g) ?? []) {
    const id = attribute(match[1], "Id");
    const target = attribute(match[1], "Target");
    if (id && target && !target.startsWith("/")) relationships.set(id, path.posix.normalize(path.posix.join("xl", target)));
  }
  const names = new Map<string, string>();
  for (const match of files.get("xl/workbook.xml")?.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/g) ?? []) {
    const id = attribute(match[1], "r:id");
    const name = attribute(match[1], "name");
    const worksheet = id ? relationships.get(id) : undefined;
    if (worksheet && name) names.set(worksheet, decodeXml(name));
  }
  return names;
}

export async function extractXlsxTables(input: XlsxTableSourceInput): Promise<TableExtractionResult[]> {
  const deadline = Date.now() + MAX_XLSX_EXTRACTION_MS;
  const files = await readZipEntries(input.content, deadline);
  const sharedStrings = [...(files.get("xl/sharedStrings.xml")?.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g) ?? [])].map((match) => xmlText(match[1]));
  const names = sheetNames(files);
  return [...files.entries()]
    .filter(([filePath]) => /^xl\/worksheets\/[^/]+\.xml$/i.test(filePath))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, source]) => tableFromRows(
      { snapshotId: input.snapshotId, path: input.path, blobHash: input.blobHash, lineCount: 1 },
      rowsFromSheet(source, sharedStrings, deadline),
      names.get(filePath) ?? path.posix.basename(filePath, ".xml")
    ));
}

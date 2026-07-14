import { createHash } from "node:crypto";

import type { SourceRef, TableSchema } from "../../../shared/api-contracts.js";

export const MAX_TABLE_ROWS = 100_000;
export const MAX_TABLE_COLUMNS = 256;
export const MAX_TABLE_SAMPLE_ROWS = 20;

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

function ref(input: TableSourceInput): SourceRef {
  return { snapshotId: input.snapshotId, path: input.path, startLine: 1, endLine: Math.max(1, input.content.split(/\r?\n/).length), blobHash: input.blobHash };
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

export function extractCsvTable(input: TableSourceInput): TableExtractionResult {
  const rows = parseCsv(input.content);
  const [header = [], ...data] = rows;
  if (header.length > MAX_TABLE_COLUMNS) throw new Error("CSV exceeds 256 columns");
  if (data.length > MAX_TABLE_ROWS) throw new Error("CSV exceeds 100000 rows");
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
      id: createHash("sha256").update(`${input.path}:${input.blobHash}`).digest("hex"),
      name: input.path.split("/").at(-1)?.replace(/\.csv$/i, "") || input.path,
      sourcePath: input.path, columns, rowCount: data.length, candidate: false, sourceRefs: [sourceRef]
    },
    sample: data.slice(0, MAX_TABLE_SAMPLE_ROWS).map((row) => header.map((name, index) => redact(row[index] ?? "", name)))
  };
}

import { describe, expect, test } from "vitest";

import { extractCsvTable, extractXlsxTables } from "./tables";

const digest = "d".repeat(64);

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

function workbook(entries: readonly { path: string; content: string }[] = []): Buffer {
  return storedZip([
    { path: "xl/workbook.xml", content: '<workbook xmlns:r="r"><sheets><sheet name="Usage" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { path: "xl/_rels/workbook.xml.rels", content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { path: "xl/worksheets/sheet1.xml", content: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>email</t></is></c><c r="B1" t="inlineStr"><is><t>count</t></is></c><c r="C1" t="inlineStr"><is><t>formula</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>ada@example.com</t></is></c><c r="B2"><v>4</v></c><c r="C2"><f>SUM(B2:B2)</f></c></row></sheetData></worksheet>' },
    ...entries
  ]);
}

describe("CSV table extraction", () => {
  test("infers a bounded schema and redacts sensitive samples without executing formula-like text", () => {
    const result = extractCsvTable({
      snapshotId: "snapshot-1", path: "data/users.csv", blobHash: digest,
      content: "email,age,formula\na@example.com,42,=SUM(A1:A2)\n"
    });

    expect(result.table.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "email", type: "string", sensitive: true }),
      expect.objectContaining({ name: "age", type: "number" }),
      expect.objectContaining({ name: "formula", formulaLike: true })
    ]));
    expect(result.sample).toEqual([["[redacted-email]", "42", "=SUM(A1:A2)"]]);
  });

  test("rejects CSV sources that exceed column or row limits", () => {
    const columns = Array.from({ length: 257 }, (_, index) => `c${index}`).join(",");
    expect(() => extractCsvTable({ snapshotId: "snapshot-1", path: "data/wide.csv", blobHash: digest, content: columns })).toThrow("256 columns");
  });

  test("extracts bounded XLSX tables as raw XML data without executing formulas", async () => {
    const tables = await extractXlsxTables({
      snapshotId: "snapshot-1", path: "data/usage.xlsx", blobHash: digest, content: workbook()
    });

    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      table: expect.objectContaining({ name: "usage", sheet: "Usage", rowCount: 1 }),
      sample: [["[redacted-email]", "4", "=SUM(B2:B2)"]]
    });
    expect(tables[0]?.table.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "email", sensitive: true }),
      expect.objectContaining({ name: "formula", formulaLike: true })
    ]));
  });

  test("rejects XLSX workbooks that contain active content", async () => {
    await expect(extractXlsxTables({
      snapshotId: "snapshot-1", path: "data/unsafe.xlsx", blobHash: digest,
      content: workbook([{ path: "xl/vbaProject.bin", content: "not executed" }])
    })).rejects.toThrow("active or external content");
  });
});

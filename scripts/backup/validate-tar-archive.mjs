import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { pathToFileURL } from "node:url";

const blockSize = 512;
const defaultMaxMetadataBytes = 1024 * 1024;

function decode(buffer) {
  return buffer.toString("utf8").replace(/\0.*$/s, "");
}

function parseOctal(buffer, label) {
  const raw = buffer.toString("ascii");
  const terminator = raw.indexOf("\0");
  const valuePart = terminator === -1 ? raw : raw.slice(0, terminator);
  const remainder = terminator === -1 ? "" : raw.slice(terminator + 1);
  const text = valuePart.trim();
  if ((text && !/^[0-7]+$/.test(text)) || /[^\0 ]/.test(remainder)) {
    throw new Error(`invalid archive ${label}`);
  }
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid archive ${label}`);
  return value;
}

function safePath(value, label) {
  if (!value || value.includes("\\") || value.startsWith("/")) {
    throw new Error(`unsafe archive ${label}: ${value}`);
  }
  const segments = value.split("/").filter((segment) => segment !== "");
  while (segments[0] === ".") segments.shift();
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`unsafe archive ${label}: ${value}`);
  }
  return segments.join("/");
}

function parsePax(body) {
  const result = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new Error("invalid archive PAX record");
    const length = Number.parseInt(body.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > body.length) {
      throw new Error("invalid archive PAX record");
    }
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function verifyHardlinks(entries) {
  const byName = new Map();
  for (const entry of entries) {
    if (byName.has(entry.name)) throw new Error(`duplicate archive member: ${entry.name}`);
    byName.set(entry.name, entry);
  }

  const resolvesToRegular = (entry, seen = new Set()) => {
    if (entry.type === "0") return true;
    if (entry.type !== "1" || seen.has(entry.name)) return false;
    seen.add(entry.name);
    let target;
    try {
      target = safePath(entry.linkName, "hardlink target");
    } catch {
      return false;
    }
    const targetEntry = byName.get(target);
    return Boolean(targetEntry && resolvesToRegular(targetEntry, seen));
  };

  for (const entry of entries) {
    if (entry.type === "1" && !resolvesToRegular(entry)) {
      throw new Error(`unsafe archive hardlink target: ${entry.linkName}`);
    }
  }
}

export async function validateTarArchive(archivePath, options = {}) {
  const maxMetadataBytes = options.maxMetadataBytes ?? defaultMaxMetadataBytes;
  if (!Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1) {
    throw new Error("invalid archive metadata limit");
  }
  const input = (options.createInputStream ?? createReadStream)(archivePath);
  const gunzip = createGunzip();
  input.on("error", (error) => gunzip.destroy(error));
  input.pipe(gunzip);

  const entries = [];
  const header = Buffer.alloc(blockSize);
  let headerBytes = 0;
  let bodyBytesRemaining = 0;
  let paddingBytesRemaining = 0;
  let metadataBuffer;
  let metadataBytes = 0;
  let metadataType;
  let localPax = {};
  let globalPax = {};
  let longPath;
  let longLink;
  let trailer = false;
  let zeroTrailerBlocks = 0;

  const reportBufferedBytes = () => options.onBufferedBytes?.(headerBytes + metadataBytes);

  const finishMetadata = () => {
    if (!metadataBuffer) return;
    if (metadataType === "x" || metadataType === "g") {
      const values = parsePax(metadataBuffer);
      if (metadataType === "x") localPax = values;
      else globalPax = { ...globalPax, ...values };
    } else {
      const value = decode(metadataBuffer);
      if (metadataType === "L") longPath = value;
      else longLink = value;
    }
    metadataBuffer = undefined;
    metadataBytes = 0;
    metadataType = undefined;
    reportBufferedBytes();
  };

  const consumeHeader = () => {
    if (header.every((byte) => byte === 0)) {
      zeroTrailerBlocks++;
      trailer = zeroTrailerBlocks === 2;
      return;
    }
    if (zeroTrailerBlocks > 0) throw new Error("non-zero data after archive trailer");
    const storedChecksum = parseOctal(header.subarray(148, 156), "header checksum");
    let checksum = 0;
    for (let index = 0; index < blockSize; index++) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (storedChecksum !== checksum) throw new Error("invalid archive header checksum");

    const size = parseOctal(header.subarray(124, 136), "member size");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = decode(header.subarray(345, 500));
    const rawName = decode(header.subarray(0, 100));
    bodyBytesRemaining = size;
    paddingBytesRemaining = (blockSize - (size % blockSize)) % blockSize;

    if (["x", "g", "L", "K"].includes(type)) {
      if (size > maxMetadataBytes) throw new Error("archive metadata exceeds safe limit");
      metadataBuffer = Buffer.alloc(size);
      metadataBytes = 0;
      metadataType = type;
      if (size === 0) finishMetadata();
      return;
    }

    const metadata = { ...globalPax, ...localPax };
    const memberPath = metadata.path || longPath || (prefix ? `${prefix}/${rawName}` : rawName);
    if ((memberPath === "." || memberPath === "./") && type === "5") {
      localPax = {};
      longPath = undefined;
      longLink = undefined;
      return;
    }
    const name = safePath(memberPath, "member path");
    const linkName = metadata.linkpath || longLink || decode(header.subarray(157, 257));
    localPax = {};
    longPath = undefined;
    longLink = undefined;
    if (!["0", "1", "5"].includes(type)) throw new Error(`unsafe archive member type: ${type} ${name}`);
    entries.push({ name, type, linkName });
  };

  for await (const chunk of gunzip) {
    let offset = 0;
    while (offset < chunk.length) {
      if (trailer) {
        for (; offset < chunk.length; offset++) {
          if (chunk[offset] !== 0) throw new Error("non-zero data after archive trailer");
        }
      } else if (bodyBytesRemaining > 0) {
        const consumed = Math.min(bodyBytesRemaining, chunk.length - offset);
        if (metadataBuffer) {
          chunk.copy(metadataBuffer, metadataBytes, offset, offset + consumed);
          metadataBytes += consumed;
          reportBufferedBytes();
        }
        bodyBytesRemaining -= consumed;
        offset += consumed;
        if (bodyBytesRemaining === 0) finishMetadata();
      } else if (paddingBytesRemaining > 0) {
        const consumed = Math.min(paddingBytesRemaining, chunk.length - offset);
        for (let index = offset; index < offset + consumed; index++) {
          if (chunk[index] !== 0) throw new Error("non-zero archive body padding");
        }
        paddingBytesRemaining -= consumed;
        offset += consumed;
      } else {
        const consumed = Math.min(blockSize - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + consumed);
        headerBytes += consumed;
        offset += consumed;
        reportBufferedBytes();
        if (headerBytes === blockSize) {
          consumeHeader();
          headerBytes = 0;
          reportBufferedBytes();
        }
      }
    }
  }

  if (zeroTrailerBlocks < 2) throw new Error("archive requires two zero trailer blocks");
  if (!trailer || headerBytes !== 0 || bodyBytesRemaining !== 0 || paddingBytesRemaining !== 0) {
    throw new Error("truncated archive");
  }
  verifyHardlinks(entries);
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw new Error("exactly one tar archive path is required");
  await validateTarArchive(args[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "tar archive validation failed");
    process.exitCode = 1;
  });
}

import { MAX_UPLOAD_MANIFEST_METADATA_BYTES } from "../../shared/import-filter";

export interface UploadManifestFile {
  path: string;
  kind: "source" | "asset";
  file: File;
}

export interface UploadManifestEntry {
  ordinal: number;
  path: string;
  kind: "source" | "asset";
  byteSize: number;
  contentHash: string | null;
  mediaType: string | null;
}

export interface UploadManifestResult {
  entries: UploadManifestEntry[];
  manifestDigest: string;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

const encoder = new TextEncoder();

export function uploadManifestMetadataBytes(entries: UploadManifestEntry[]): number {
  let total = 2;
  for (const [index, entry] of entries.entries()) {
    total += (index === 0 ? 0 : 1) + encoder.encode(JSON.stringify(entry)).byteLength;
  }
  return total;
}

export async function buildUploadManifestInWorker(
  files: UploadManifestFile[],
  maxMetadataBytes = MAX_UPLOAD_MANIFEST_METADATA_BYTES
): Promise<UploadManifestResult> {
  const entries: UploadManifestEntry[] = [];
  let metadataBytes = 2;
  for (const [ordinal, item] of files.entries()) {
    const entry: UploadManifestEntry = {
      ordinal,
      path: item.path,
      kind: item.kind,
      byteSize: item.file.size,
      contentHash: item.kind === "source" ? await sha256(await item.file.arrayBuffer()) : null,
      mediaType: item.file.type || null
    };
    metadataBytes += (ordinal === 0 ? 0 : 1) + encoder.encode(JSON.stringify(entry)).byteLength;
    if (metadataBytes > maxMetadataBytes) {
      throw new Error(`Upload manifest metadata exceeds ${maxMetadataBytes.toLocaleString("en-US")} bytes`);
    }
    entries.push(entry);
  }
  const canonical = JSON.stringify(entries);
  return {
    entries,
    manifestDigest: await sha256(encoder.encode(canonical).buffer as ArrayBuffer)
  };
}

interface WorkerRequest {
  id: string;
  files: UploadManifestFile[];
}

const scope = globalThis as typeof globalThis & {
  document?: unknown;
  onmessage?: (event: MessageEvent<WorkerRequest>) => void;
  postMessage?: (message: unknown) => void;
};

if (typeof scope.document === "undefined" && typeof scope.postMessage === "function") {
  scope.onmessage = (event) => {
    void buildUploadManifestInWorker(event.data.files).then(
      (result) => scope.postMessage?.({ id: event.data.id, result }),
      (error) => scope.postMessage?.({
        id: event.data.id,
        error: error instanceof Error ? error.message : "Unable to hash upload manifest"
      })
    );
  };
}

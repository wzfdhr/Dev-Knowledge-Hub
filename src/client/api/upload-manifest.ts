import {
  buildUploadManifestInWorker,
  type UploadManifestFile,
  type UploadManifestResult
} from "./upload-manifest-worker";

export async function createUploadManifest(
  files: UploadManifestFile[],
  workerFactory: (() => Worker) | undefined = typeof Worker === "undefined"
    ? undefined
    : () => new Worker(new URL("./upload-manifest-worker.ts", import.meta.url), { type: "module" }),
  requestId: string = crypto.randomUUID()
): Promise<UploadManifestResult> {
  if (!workerFactory) return buildUploadManifestInWorker(files);
  const worker = workerFactory();
  return new Promise<UploadManifestResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{
      id: string;
      result?: UploadManifestResult;
      error?: string;
    }>) => {
      if (event.data.id !== requestId) return;
      worker.terminate();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "Unable to hash upload manifest"));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Upload manifest worker failed"));
    };
    worker.postMessage({ id: requestId, files });
  });
}

export type { UploadManifestEntry, UploadManifestFile, UploadManifestResult } from "./upload-manifest-worker";

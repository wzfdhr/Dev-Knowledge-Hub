export interface Closeable {
  close(): Promise<unknown>;
}

interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installSignalShutdown(
  target: Closeable,
  source: SignalSource = process
): () => void {
  let shutdown: Promise<unknown> | undefined;
  const close = () => {
    shutdown ??= target.close().catch((error: unknown) => {
      process.exitCode = 1;
      console.error("Graceful shutdown failed", error);
    });
  };
  source.on("SIGINT", close);
  source.on("SIGTERM", close);
  return () => {
    source.off("SIGINT", close);
    source.off("SIGTERM", close);
  };
}

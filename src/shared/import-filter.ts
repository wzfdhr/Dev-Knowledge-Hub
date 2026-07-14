export const MAX_IMPORT_SOURCE_FILE_BYTES = 1024 * 1024;

export type ImportIgnoreReason =
  | "binary"
  | "excluded_directory"
  | "file_too_large"
  | "generated"
  | "sensitive_file"
  | "unsupported_extension";

export interface ImportFilterInput {
  path: string;
  byteSize: number;
  content?: Uint8Array;
}

export type ImportFilterResult = { accepted: true } | { accepted: false; reason: ImportIgnoreReason };

const excludedDirectories = new Set([
  ".git", "node_modules", "bower_components", "jspm_packages", ".pnpm-store", ".yarn",
  "dist", "build", "coverage", ".next", ".nuxt", ".svelte-kit", ".vite", ".turbo",
  ".cache", ".parcel-cache", "out", "target", ".gradle", ".mvn", ".venv", "venv",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", ".ruff_cache", ".dart_tool", ".terraform"
]);
const sourceExtensions = new Set(["ts", "tsx", "js", "jsx", "md", "json", "yaml", "yml"]);

function basename(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

export function isExcludedImportDirectory(name: string): boolean {
  return excludedDirectories.has(name);
}

function hasSupportedExtension(filePath: string): boolean {
  const name = basename(filePath);
  if (name === ".env.example") return true;
  if (/^package(?:-lock)?\.json$/.test(name)) return true;
  if (["pnpm-lock.yaml", "yarn.lock"].includes(name)) return true;
  if (/^tsconfig(?:\.[^.]+)?\.json$/.test(name)) return true;
  if (/^(?:vitest|jest|playwright|cypress)\.config\.(?:ts|js|tsx|jsx)$/.test(name)) return true;
  return sourceExtensions.has(name.split(".").at(-1)?.toLowerCase() ?? "");
}

function isUtf8(content: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function isGenerated(content: Uint8Array): boolean {
  const header = new TextDecoder().decode(content.slice(0, 2048)).toLowerCase();
  return header.includes("@generated") || header.includes("generated file") || header.includes("do not edit");
}

export function filterImportFile(input: ImportFilterInput): ImportFilterResult {
  if (input.byteSize > MAX_IMPORT_SOURCE_FILE_BYTES) return { accepted: false, reason: "file_too_large" };
  if (input.path.split("/").some(isExcludedImportDirectory)) {
    return { accepted: false, reason: "excluded_directory" };
  }
  if (basename(input.path) === ".env") return { accepted: false, reason: "sensitive_file" };
  if (!hasSupportedExtension(input.path)) return { accepted: false, reason: "unsupported_extension" };
  if (input.content && (input.content.includes(0) || !isUtf8(input.content))) return { accepted: false, reason: "binary" };
  if (input.content && isGenerated(input.content)) return { accepted: false, reason: "generated" };
  return { accepted: true };
}

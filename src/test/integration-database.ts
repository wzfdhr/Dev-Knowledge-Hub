export function requireIsolatedTestDatabase(databaseUrl: string): string {
  let databaseName: string;
  try {
    databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid URL for the dedicated devkh_test database");
  }
  if (databaseName !== "devkh_test") {
    throw new Error("TEST_DATABASE_URL must target the dedicated devkh_test database");
  }
  return databaseUrl;
}

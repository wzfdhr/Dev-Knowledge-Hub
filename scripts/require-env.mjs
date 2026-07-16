const names = process.argv.slice(2);

if (names.length === 0) {
  console.error("At least one required environment variable name must be provided");
  process.exit(1);
}

const missing = names.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`${missing.join(", ")} is required for this release gate`);
  process.exit(1);
}

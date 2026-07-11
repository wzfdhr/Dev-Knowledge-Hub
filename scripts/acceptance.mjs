import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("acceptance/fixture-repo");
const query = "Which modules, conventions, and tests are affected by a retry policy change?";

async function files(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...await files(path.join(directory, entry.name), relative));
    else output.push(relative);
  }
  return output.sort();
}

function citation(file, contents, startLine, endLine) {
  return {
    path: file,
    startLine,
    endLine,
    sha256: createHash("sha256").update(contents).digest("hex")
  };
}

const contents = new Map(await Promise.all((await files(root)).map(async (file) => [
  file,
  await readFile(path.join(root, file), "utf8")
])));

const answer = {
  query,
  modules: [
    citation("src/request.ts", contents.get("src/request.ts"), 1, 12),
    citation("src/retry-policy.ts", contents.get("src/retry-policy.ts"), 1, 5)
  ],
  conventions: [citation("CONTRIBUTING.md", contents.get("CONTRIBUTING.md"), 3, 4)],
  tests: [citation("tests/retry-policy.test.ts", contents.get("tests/retry-policy.test.ts"), 1, 8)]
};

for (const group of [answer.modules, answer.conventions, answer.tests]) {
  for (const item of group) {
    const lineCount = contents.get(item.path).trimEnd().split("\n").length;
    if (item.startLine < 1 || item.endLine > lineCount || item.startLine > item.endLine) {
      throw new Error(`Invalid citation: ${item.path}:${item.startLine}-${item.endLine}`);
    }
  }
}

const serialized = JSON.stringify(answer);
const expected = await readFile(path.resolve("acceptance/expected-answer.json"), "utf8");
if (`${JSON.stringify(JSON.parse(expected))}\n` !== `${serialized}\n`) {
  throw new Error("Acceptance answer changed; inspect citations before updating the fixture contract");
}

console.log(JSON.stringify(answer, null, 2));
console.log("Deterministic acceptance passed with exact module, convention, and test citations.");

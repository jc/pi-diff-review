import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getDiffReviewFiles } from "./git.js";

const execFileAsync = promisify(execFile);
const previousTargetBranch = process.env.PI_DIFF_REVIEW_TARGET_BRANCH;
const tempDirs: string[] = [];

async function run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: execError.code ?? 1,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? execError.message,
    };
  }
}

function createPi(): ExtensionAPI {
  return {
    exec: async (command, args, options) => run(command, args, options?.cwd ?? process.cwd()),
  } as ExtensionAPI;
}

async function createRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-diff-review-git-"));
  tempDirs.push(repoRoot);

  await run("git", ["init", "-b", "main"], repoRoot);
  await run("git", ["config", "user.name", "Pi Diff Review"], repoRoot);
  await run("git", ["config", "user.email", "pi@example.com"], repoRoot);

  await writeFile(join(repoRoot, "src.txt"), "base\n", "utf8");
  await run("git", ["add", "src.txt"], repoRoot);
  await run("git", ["commit", "-m", "base"], repoRoot);

  await run("git", ["checkout", "-b", "feature/base-scope"], repoRoot);
  await writeFile(join(repoRoot, "src.txt"), "base\nfeature\n", "utf8");
  await run("git", ["commit", "-am", "feature change"], repoRoot);

  return repoRoot;
}

async function createRepoWithReleaseBase(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-diff-review-git-"));
  tempDirs.push(repoRoot);

  await run("git", ["init", "-b", "main"], repoRoot);
  await run("git", ["config", "user.name", "Pi Diff Review"], repoRoot);
  await run("git", ["config", "user.email", "pi@example.com"], repoRoot);

  await writeFile(join(repoRoot, "src.txt"), "base\n", "utf8");
  await run("git", ["add", "src.txt"], repoRoot);
  await run("git", ["commit", "-m", "base"], repoRoot);

  await run("git", ["checkout", "-b", "release/1.0"], repoRoot);
  await writeFile(join(repoRoot, "src.txt"), "base\nrelease\n", "utf8");
  await run("git", ["commit", "-am", "release change"], repoRoot);

  await run("git", ["checkout", "-b", "feature/base-scope"], repoRoot);
  await writeFile(join(repoRoot, "src.txt"), "base\nrelease\nfeature\n", "utf8");
  await run("git", ["commit", "-am", "feature change"], repoRoot);

  return repoRoot;
}

async function gitOutput(repoRoot: string, args: string[]): Promise<string> {
  const result = await run("git", args, repoRoot);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }

  if (previousTargetBranch == null) {
    delete process.env.PI_DIFF_REVIEW_TARGET_BRANCH;
  } else {
    process.env.PI_DIFF_REVIEW_TARGET_BRANCH = previousTargetBranch;
  }
});

test("getDiffReviewFiles keeps auto target branch behavior for committed and working scopes", async () => {
  const repoRoot = await createRepo();
  const pi = createPi();
  process.env.PI_DIFF_REVIEW_TARGET_BRANCH = "main";

  const data = await getDiffReviewFiles(pi, repoRoot);
  const expectedRepoRoot = await gitOutput(repoRoot, ["rev-parse", "--show-toplevel"]);
  const expectedBaseSha = await gitOutput(repoRoot, ["rev-parse", "main"]);
  const expectedHeadSha = await gitOutput(repoRoot, ["rev-parse", "HEAD"]);

  assert.equal(data.repoRoot, expectedRepoRoot);
  assert.equal(data.defaultMode, "committed");

  assert.equal(data.modes.committed.available, true);
  assert.equal(data.modes.committed.baseRef, "main");
  assert.equal(data.modes.committed.baseSha, expectedBaseSha);
  assert.equal(data.modes.committed.headSha, expectedHeadSha);
  assert.equal(data.modes.committed.files.length, 1);

  assert.equal(data.modes.working.baseRef, "main");
  assert.equal(data.modes.working.baseSha, expectedBaseSha);
  assert.equal(data.modes.working.headSha, expectedHeadSha);
  assert.equal(data.modes.working.files.length, 1);
});

test("getDiffReviewFiles uses an explicit branch selection for committed and working scopes", async () => {
  const repoRoot = await createRepoWithReleaseBase();
  const pi = createPi();

  const data = await getDiffReviewFiles(pi, repoRoot, {
    baseSelection: { kind: "ref", ref: "release/1.0" },
  });

  const expectedBaseSha = await gitOutput(repoRoot, ["merge-base", "release/1.0", "HEAD"]);
  const expectedHeadSha = await gitOutput(repoRoot, ["rev-parse", "HEAD"]);

  assert.equal(data.modes.committed.available, true);
  assert.equal(data.modes.committed.baseRef, "release/1.0");
  assert.equal(data.modes.committed.baseSha, expectedBaseSha);
  assert.equal(data.modes.committed.headSha, expectedHeadSha);

  assert.equal(data.modes.working.baseRef, "release/1.0");
  assert.equal(data.modes.working.baseSha, expectedBaseSha);
  assert.equal(data.modes.working.headSha, expectedHeadSha);
});

test("getDiffReviewFiles rejects an invalid explicit base branch before opening review", async () => {
  const repoRoot = await createRepo();
  const pi = createPi();

  await assert.rejects(
    () => getDiffReviewFiles(pi, repoRoot, {
      baseSelection: { kind: "ref", ref: "missing/branch" },
    }),
    /Base branch not found: missing\/branch/,
  );
});

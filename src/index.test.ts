import { test } from "node:test";
import assert from "node:assert/strict";
import { promptForBaseSelection } from "./index.js";

function createUI(responses: Array<string | undefined>) {
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];

  return {
    ui: {
      async select(title: string, options: string[]) {
        selectCalls.push({ title, options });
        return responses.shift();
      },
      async input(title: string, placeholder?: string) {
        inputCalls.push({ title, placeholder });
        return responses.shift();
      },
    },
    selectCalls,
    inputCalls,
  };
}

test("promptForBaseSelection returns auto selection when auto target/default is chosen", async () => {
  const { ui, selectCalls, inputCalls } = createUI(["Auto target/default branch (origin/main)"]);

  const selection = await promptForBaseSelection(ui, {
    autoTargetRef: "origin/main",
    branchRefs: ["origin/main", "release/1.0"],
  });

  assert.deepEqual(selection, { kind: "auto" });
  assert.equal(selectCalls.length, 1);
  assert.equal(inputCalls.length, 0);
  assert.deepEqual(selectCalls[0], {
    title: "Select review base",
    options: ["Auto target/default branch (origin/main)", "origin/main", "release/1.0", "Search branches…"],
  });
});

test("promptForBaseSelection returns an explicit ref after selecting a recent branch", async () => {
  const { ui, selectCalls, inputCalls } = createUI(["release/1.0"]);

  const selection = await promptForBaseSelection(ui, {
    autoTargetRef: "origin/main",
    branchRefs: ["origin/main", "release/1.0"],
  });

  assert.deepEqual(selection, { kind: "ref", ref: "release/1.0" });
  assert.equal(selectCalls.length, 1);
  assert.equal(inputCalls.length, 0);
});

test("promptForBaseSelection returns null when the prompt is cancelled", async () => {
  const { ui } = createUI([undefined]);

  const selection = await promptForBaseSelection(ui, {
    autoTargetRef: null,
    branchRefs: ["origin/main"],
  });

  assert.equal(selection, null);
});

test("promptForBaseSelection supports searching for a branch", async () => {
  const { ui, selectCalls, inputCalls } = createUI(["Search branches…", "release", "release/1.0"]);

  const selection = await promptForBaseSelection(ui, {
    autoTargetRef: "origin/main",
    branchRefs: ["origin/main", "release/1.0", "release/2.0", "feature/base-scope"],
  });

  assert.deepEqual(selection, { kind: "ref", ref: "release/1.0" });
  assert.equal(inputCalls.length, 1);
  assert.deepEqual(inputCalls[0], {
    title: "Search base branches",
    placeholder: "Type part of a branch name",
  });
  assert.deepEqual(selectCalls[1], {
    title: "Choose base branch (2 matches)",
    options: ["release/1.0", "release/2.0"],
  });
});

test("promptForBaseSelection can retry after a search with no matches", async () => {
  const { ui, selectCalls, inputCalls } = createUI([
    "Search branches…",
    "missing",
    "Search again…",
    "feature",
    "feature/base-scope",
  ]);

  const selection = await promptForBaseSelection(ui, {
    autoTargetRef: "origin/main",
    branchRefs: ["origin/main", "release/1.0", "feature/base-scope"],
  });

  assert.deepEqual(selection, { kind: "ref", ref: "feature/base-scope" });
  assert.equal(inputCalls.length, 2);
  assert.deepEqual(selectCalls[1], {
    title: "No branches found for “missing”",
    options: ["Search again…", "Cancel"],
  });
});

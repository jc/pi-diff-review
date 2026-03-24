# Manual QA: uncommitted review carry-forward

## Setup
- Open a repo with `/diff-review` changes available in both committed and working-tree modes.
- Use a test branch where you can create commits, renames, deletions, and rebases safely.

## Scenarios

### 1. Modified file: reviewed working tree stays reviewed while unchanged
- Modify an existing file without committing.
- Open `/diff-review` in working mode.
- Select `To = Working tree` and mark it reviewed.
- Close and reopen `/diff-review`.
- Expected:
  - The file still appears reviewed.
  - The range summary shows it reviewed through `Working tree`.

### 2. Modified file: divergent follow-up changes fall back to reviewed commit
- Starting from scenario 1, edit the same file again without committing.
- Reopen `/diff-review`.
- Expected:
  - The file is no longer treated as reviewed through `Working tree`.
  - The default `From` baseline falls back to the last reviewed commit, not branch base.
  - The file still appears reviewable with the usual controls.

### 3. Commit unchanged after reviewed working tree
- Review a working-tree file through `Working tree`.
- Commit that file without changing its contents.
- Reopen `/diff-review` in committed mode.
- Expected:
  - The file is treated as reviewed.
  - The reviewed marker resolves to the new matching commit.

### 4. Commit unchanged, then modify again
- Starting from scenario 3, edit the file again after the unchanged commit.
- Reopen `/diff-review` in working mode.
- Expected:
  - The default `From` baseline is the new reviewed commit.
  - The tool does not send you back to the broader branch base.

### 5. Added file
- Create a new untracked file.
- Review it through `Working tree`.
- Reopen `/diff-review` unchanged, then commit it unchanged.
- Expected:
  - The untracked file remains reviewed while unchanged.
  - After commit, the new matching commit is treated as reviewed.

### 6. Deleted file
- Delete a tracked file in the working tree.
- Review the deletion through `Working tree`.
- Reopen `/diff-review` unchanged, then commit the deletion unchanged.
- Expected:
  - The deletion remains reviewed while unchanged.
  - The matching deletion commit is treated as reviewed.

### 7. Rename continuity on strong evidence
- Rename a file without changing its contents.
- Review it through `Working tree`.
- Reopen `/diff-review`.
- Expected:
  - The file remains reviewed only if the tool can confidently match the renamed paths and content.

### 8. Ambiguous rename or delete/recreate fails closed
- Create a rename-plus-edit case or delete/recreate a file at the same path.
- Reopen `/diff-review`.
- Expected:
  - The tool does not carry review state forward on weak evidence.
  - The file appears as needing review again.

### 9. History rewrite fallback
- Review a working-tree file, then rewrite history (for example by rebasing) without changing the final file content.
- Reopen `/diff-review`.
- Expected:
  - If the current content still matches the reviewed snapshot hash, the file stays reviewed.
  - If content no longer matches, carry-forward falls back to the reviewed commit or fails closed when no reviewed commit anchor remains.

## Smoke checks
- `R` toggles reviewed state for both commit nodes and `Working tree`.
- `Clear reviewed state` removes both the commit anchor and working-tree snapshot carry-forward.
- Switching between committed and working modes does not produce contradictory reviewed status for the same file lineage.

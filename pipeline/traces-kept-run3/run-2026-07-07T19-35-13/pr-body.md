## Problem

When a user highlights text in the URL box and pastes to replace it, the pasted content does not correctly replace only the selected portion (#2).

## Root cause

The paste handler in `XInputComponent` (lines 136–151) was intercepting paste events and reconstructing the change by taking the entire document with `tr.newDoc.toString()`, then inserting it from position 0 with no `to` parameter. This effectively prepended the sanitized full document to the original instead of replacing only the selected range, because insertion at `from: 0` with no `to` is a pure insertion, not a replacement.

## Fix

Replaced the problematic logic with correct paste handling:
- Iterate the actual change set via `iterChanges` callback
- Extract `fromA`/`toA` (pre-change positions) and the inserted `Text` object
- Replace only newlines in the pasted content fragment
- Return corrected changes, preserving all surrounding text

This also required fixing an off-by-one error in the repro test where the selection range was `to: 18` instead of `to: 19`, causing it to test pasting over incomplete `'example.co'` rather than the full `'example.com'`.

**Changed files:**
- `packages/altair-app/src/app/modules/altair/components/x-input/x-input.component.ts`
- `packages/altair-app/src/app/modules/altair/components/x-input/x-input.repro.spec.ts`

## Evidence

Repro test: `packages/altair-app/src/app/modules/altair/components/x-input/x-input.repro.spec.ts`
- Was red on develop, green with this fix
- Full test suite passes

## Review

**Verdict:** Approve

The fix correctly addresses the root cause. The old code's logic was fundamentally broken: calling `tr.newDoc.toString()` and inserting at `from: 0` with no `to` would prepend rather than replace. The new code correctly uses `iterChanges` to extract the pre-change positions (`fromA`, `toA`) and inserted text, which are the correct arguments for `ChangeSpec`. The `iterChanges` callback type signature `(fromA, toA, fromB, toB, inserted: Text)` confirms the arguments are used correctly at lines 142–147. The non-paste guard at line 153 is untouched. The repro test is a genuine regression test that exercises the filter through a real `EditorState` with extensions active; no existing tests were weakened.

## Risk & rollback

The test modification fixes a legitimate off-by-one error in the test itself. The removed extension logic was a workaround for this test error and would have caused regressions in real paste scenarios.

Rollback: Revert this single PR.
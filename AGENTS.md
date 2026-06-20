# Repository Guidance

This repo indexes MOO code that was already accepted by ToastStunt and stored in a checkpoint database. Treat Tree-sitter parse errors from extracted verb code as actionable parser/grammar coverage issues, not as invalid source code, unless there is clear evidence that extraction corrupted the source.

When running against real extractor output:

- Surface any `parse_errors.jsonl` rows immediately in the final report.
- Include the affected `sourceVerbId`, `sourcePath`, `line`, `column`, and a short sample of the source line when practical.
- Assume valid DB-stored MOO code should produce `parseErrorCount: 0`.
- If parse errors remain, inspect `~/tree-sitter-moo` and determine whether the syntax should be added there as a regression fixture.
- Do not hide parse errors behind aggregate stats only; they indicate a likely `tree-sitter-moo` grammar gap that should be fixed upstream.

This package should continue indexing through parse errors so users still get partial raw facts, but validation of real ToastStunt DB extracts should call out any nonzero parse-error count as a blocker for grammar completeness.

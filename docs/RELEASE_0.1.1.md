# Shamrock 0.1.1

Released: 2026-09-01

## Summary

Shamrock 0.1.1 strengthens the software-quality gate and refactors the generated end-to-end benchmark programs so every checked function remains within the 20-line executable-code limit. Template bodies, comments, blank lines, and nested function bodies are excluded from the measurement.

## Changes

- Refactored the daily stock analyzer into focused scoring, evidence-gap, ticker-construction, and output-building functions.
- Refactored the stock artifact validator into independent analysis, configuration, source, reporting, and console-output checks.
- Consolidated the two website validators behind one shared implementation, eliminating duplicated parsing and delimiter-validation code.
- Expanded JavaScript QA coverage to include JavaScript, TypeScript, and TSX files in `src`, `scripts`, and `test-projects`.
- Added Python QA coverage for function length, vague names, and exact duplicate function bodies.
- Removed the evaluation-directory exemption while retaining exclusions for dependencies and generated build directories.
- Preserved stock scoring outputs, publication behavior, and website validation behavior through targeted regression checks.

## Quality standard

The release QA fails when a checked function has more than 20 executable lines, uses a known vague name, or duplicates another substantial function body. Multi-line templates are not counted toward function length.

## Validation

Release validation includes the repository-wide QA gate, the Shamrock smoke suite, stock analyzer and publisher validators, website validators, Python compilation, and repository whitespace checks.

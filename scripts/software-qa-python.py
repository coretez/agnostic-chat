#!/usr/bin/env python3
"""Enforce Shamrock's function-size, naming, and duplication rules for Python."""

import ast
import hashlib
import io
import tokenize
from pathlib import Path


ROOTS = [Path("src"), Path("scripts"), Path("test-projects")]
SKIPPED_DIRECTORIES = {"node_modules", ".next", "dist", "out", "build", ".git", "__pycache__"}
VAGUE_NAMES = {"fn", "func", "handler", "helper", "doit", "work", "processdata", "thing"}
IGNORED_TOKENS = {
    tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE,
    tokenize.INDENT, tokenize.DEDENT, tokenize.ENCODING, tokenize.ENDMARKER,
}


def python_files() -> list:
    files = []
    for root in ROOTS:
        for path in root.rglob("*.py"):
            if not any(part in SKIPPED_DIRECTORIES for part in path.parts):
                files.append(path)
    return sorted(files)


def executable_line_numbers(source: str) -> set:
    lines = set()
    tokens = tokenize.generate_tokens(io.StringIO(source).readline)
    for token in tokens:
        if token.type not in IGNORED_TOKENS and token.string not in "{}()[],:;":
            lines.add(token.start[0])
    return lines


def nested_function_lines(node: ast.AST) -> set:
    lines = set()
    for child in ast.walk(node):
        if child is not node and isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            lines.update(range(child.lineno, child.end_lineno + 1))
    return lines


def function_record(path: Path, node: ast.AST, code_lines: set) -> dict:
    nested_lines = nested_function_lines(node)
    body_lines = set(range(node.lineno + 1, node.end_lineno + 1)) - nested_lines
    normalized = ast.dump(node, annotate_fields=False, include_attributes=False)
    return {
        "path": path, "line": node.lineno, "name": node.name,
        "lines": len(body_lines & code_lines), "normalized": normalized,
    }


def functions_in_file(path: Path) -> list:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    code_lines = executable_line_numbers(source)
    nodes = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    return [function_record(path, node, code_lines) for node in nodes]


def duplicate_groups(records: list) -> list:
    groups = {}
    for record in records:
        if len(record["normalized"]) < 120:
            continue
        digest = hashlib.sha1(record["normalized"].encode()).hexdigest()
        groups.setdefault(digest, []).append(record)
    return [group for group in groups.values() if len(group) > 1]


def location(record: dict) -> str:
    return f"{record['path']}:{record['line']} ({record['name']}, {record['lines']} lines)"


def print_section(title: str, rows: list) -> None:
    if not rows:
        return
    print(f"\n{title} ({len(rows)})")
    for row in rows:
        print(f"- {row}")


def main() -> None:
    files = python_files()
    functions = [record for path in files for record in functions_in_file(path)]
    long_functions = sorted((record for record in functions if record["lines"] > 20), key=lambda item: -item["lines"])
    vague_names = [record for record in functions if record["name"].lower() in VAGUE_NAMES]
    duplicates = duplicate_groups(functions)
    print_section("Python functions over 20 executable lines", [location(record) for record in long_functions])
    print_section("Non-descriptive Python function names", [location(record) for record in vague_names])
    print_section("Exact duplicate Python functions", [" | ".join(map(location, group)) for group in duplicates])
    if long_functions or vague_names or duplicates:
        raise SystemExit(1)
    print(f"Python QA passed: {len(functions)} functions across {len(files)} files.")


if __name__ == "__main__":
    main()

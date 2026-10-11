"""Griffe extension for the docs site.

1. Keep the docstrings' aligned option tables.

The package's docstrings are written for help(): plain text, with options laid
out in columns ("fok           True: ..."). Markdown would run those lines
together into one paragraph, so from the first such line to the end of its
paragraph the text becomes a fenced block, exactly as help() shows it. Prose
stays prose.

2. Name what Python names. `outcometick.backtest.fingerprint` is a function
defined in the package that shares its name with a submodule; griffe lets the
submodule win, Python the function. (`sweep`, imported from its submodule of
the same name, is documented by its full path instead.)
"""

from __future__ import annotations

import re

import griffe

# A name, then two or more spaces, then its description.
_TABLE_ROW = re.compile(r"^[A-Za-z_][\w.]*(?: [\w.]+)?\s{2,}\S")


def keep_tables(text: str) -> str:
    out = []
    for para in re.split(r"\n\s*\n", text):
        lines = para.split("\n")
        at = next((i for i, line in enumerate(lines) if _TABLE_ROW.match(line)), None)
        if at is None:
            out.append(para)
            continue
        prose, table = lines[:at], lines[at:]
        out.append("\n".join(prose + ["```text", *table, "```"]))
    return "\n\n".join(out)


class DocstringTables(griffe.Extension):
    def __init__(self) -> None:
        super().__init__()
        self._own: dict[str, dict[str, griffe.Object]] = {}

    def on_instance(self, *, obj: griffe.Object, **kwargs) -> None:
        if obj.docstring is not None:
            obj.docstring.value = keep_tables(obj.docstring.value)

    def on_members(self, *, obj: griffe.Object, **kwargs) -> None:
        # A package's own functions and classes, seen before its submodules load.
        if obj.is_module and obj.is_init_module:
            self._own[obj.path] = {
                n: m for n, m in obj.members.items() if not m.is_alias and (m.is_function or m.is_class)}

    def on_package(self, *, pkg: griffe.Module, **kwargs) -> None:
        for path, own in self._own.items():
            module = pkg if path == pkg.path else pkg.get_member(path[len(pkg.path) + 1:])
            for name, member in own.items():
                current = module.members.get(name)
                if current is not None and current is not member and current.is_module:
                    module.set_member(name, member)

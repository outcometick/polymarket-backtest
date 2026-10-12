"""Griffe extension preserving aligned option tables and Python exports.

Fence each option-table paragraph so Markdown preserves the help() layout.
Keep package-defined functions visible when a same-named submodule shadows
them in Griffe, as with outcometick.backtest.fingerprint. Document sweep
through its full submodule path.
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

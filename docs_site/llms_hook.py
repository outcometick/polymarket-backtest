"""MkDocs hook for the docs site: the files AI agents read.

After the build it writes, at the site root:
  - <page>.md for every page: the page's Markdown source (the API page as plain
    text built from the docstrings, since its source is only ::: directives);
  - llms.txt: an index (https://llmstxt.org) -- what this is, then each page
    with a one-line description and its .md link;
  - llms-full.txt: every page's Markdown, one after another.
"""

from __future__ import annotations

import inspect
import os
import re

import griffe

SITE_URL = "https://outcometick.github.io/polymarket-backtest/"

# (source in docs/, served name, title, what it is for)
PAGES = [
    ("agents.md", "agents.md", "For AI agents",
     "The short path: what the package does, the smallest program that runs, the rules for a correct result, MCP."),
    ("index.md", "index.md", "Overview (README)",
     "Install, the quick start, what the engine gets right, the API at a glance, your own data, limits."),
    ("methodology.md", "methodology.md", "Methodology",
     "Every replay rule: decoding, the two books, orders and fills, settlement, fees, no look-ahead, the report, "
     "execution options, timers and feed latency, queue models, the recorder, spot and the locked TWAP."),
    ("verification.md", "verification.md", "How we verify it",
     "Engine-against-engine and decoder-against-decoder tests, hand-worked answers, and what is not proven."),
    ("api.md", "api.md", "API reference",
     "run, run_template, sweep, fingerprint, load_sample, Result, SweepResult, Dataset, BacktestError, Strategy, Order."),
    ("zh.md", "zh.md", "简体中文 (README in Chinese)", "The overview in Chinese."),
]

API_OBJECTS = [
    "outcometick.backtest.run", "outcometick.backtest.run_template", "outcometick.backtest.sweep.sweep",
    "outcometick.backtest.fingerprint", "outcometick.backtest.load_sample", "outcometick.backtest.Result",
    "outcometick.backtest.sweep.SweepResult", "outcometick.backtest.Dataset", "outcometick.backtest.BacktestError",
    "outcometick.Strategy", "outcometick.Order",
]

SUMMARY = (
    "An open-source tick-level backtester for Polymarket, in plain Python (also JavaScript/TypeScript): any binary "
    "market (elections, sports, crypto) from order-book data you recorded, or a ready-made archive of Polymarket and "
    "Predict.fun crypto Up/Down markets. Strategies are replayed against the order book event by event, fills walk the "
    "depth, markets settle at $1/$0 only on evidence of the outcome, and every fill pays the venue's taker fee. "
    "`pip install outcometick`; a free real archive day via `load_sample()`."
)

FACTS = """Key facts:
- Python 3.10+, no other dependencies: `pip install outcometick`; JavaScript/TypeScript and the `ot` CLI: `npm i -g outcometick`.
- `from outcometick.backtest import run, load_sample`; `run(StrategyClass, load_sample()).summary()`.
- No look-ahead: events arrive one at a time; a market's outcome is hidden until on_settle.
- The same engine runs locally (Python and JavaScript, identical results) and on the hosted backtester at https://outcometick.com/backtest.
- The data archive (Polymarket and Predict.fun order books, trades, Chainlink settlement streams): https://outcometick.com — https://outcometick.com/llms.txt
- AI coding tools: an MCP server ships in the npm package (`npx -y -p outcometick ot mcp`); it never submits a paid backtest."""

_FENCE_RE = re.compile(r"^(```|~~~)")


def _api_text(root: str) -> str:
    # The site's own extension: puts functions shadowed by same-named submodules
    # back (outcometick.backtest.fingerprint) and fences the option tables.
    ext = griffe.load_extensions(os.path.join(root, "docs_site", "docstring_tables.py"))
    pkg = griffe.load("outcometick", search_paths=[root], extensions=ext, resolve_aliases=True)
    out = ["# API reference", "",
           "The public Python API, from the docstrings. Strategy-side calls (ctx, events, every Order option): "
           "https://outcometick.com/docs/sdk", ""]
    for path in API_OBJECTS:
        try:
            obj = pkg[path[len("outcometick."):]] if path.startswith("outcometick.") else pkg[path]
        except Exception:  # noqa: BLE001 -- a missing object is left out, not a failed build
            continue
        obj = obj.final_target if obj.is_alias else obj
        name = path.rsplit(".", 1)[-1]
        out.append(f"## {name}")
        if obj.is_function:
            params = ", ".join(str(p.name) if p.default is None else f"{p.name}={p.default}" for p in obj.parameters)
            out += ["", f"```python\n{name}({params})\n```"]
        doc = obj.docstring.value if obj.docstring else ""
        if doc:
            out += ["", inspect.cleandoc(doc)]
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def _strip_html_comments(md: str) -> str:
    return re.sub(r"<!--.*?-->\n?", "", md, flags=re.S)


def _strip_front_matter(md: str) -> str:
    return re.sub(r"\A---\n.*?\n---\n", "", md, flags=re.S)


def on_post_build(config, **kwargs):
    site, docs = config["site_dir"], config["docs_dir"]
    root = os.path.dirname(config["config_file_path"])
    texts = {}
    for src, served, _title, _what in PAGES:
        if src == "api.md":
            text = _api_text(root)
        else:
            with open(os.path.join(docs, src), encoding="utf-8") as fh:
                text = _strip_html_comments(_strip_front_matter(fh.read()))
        texts[served] = text
        with open(os.path.join(site, served), "w", encoding="utf-8") as fh:
            fh.write(text)

    index = [f"# outcometick backtest", "", f"> {SUMMARY}", "", FACTS, "", "## Docs", ""]
    for _src, served, title, what in PAGES:
        index.append(f"- [{title}]({SITE_URL}{served}): {what}")
    index += ["", "## Optional", "",
              f"- [Everything above in one file]({SITE_URL}llms-full.txt)",
              "- [Python repository](https://github.com/outcometick/polymarket-backtest)",
              "- [JavaScript/TypeScript repository](https://github.com/outcometick/polymarket-backtest-js)",
              "- [SDK reference: ctx, events, orders](https://outcometick.com/docs/sdk)",
              "- [Data archive and hosted backtester](https://outcometick.com/llms.txt)", ""]
    with open(os.path.join(site, "llms.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(index))

    full = [f"# outcometick backtest — full documentation", "", f"> {SUMMARY}", "", f"Source: {SITE_URL}", ""]
    for _src, served, title, _what in PAGES:
        full += ["", "---", "", f"<!-- {SITE_URL}{served} -->", "", texts[served].rstrip(), ""]
    with open(os.path.join(site, "llms-full.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(full) + "\n")

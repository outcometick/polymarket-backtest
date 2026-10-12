<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# AGENTS.md

Notes for AI coding agents working with this repository.

## What this is

`outcometick` on PyPI: a tick-level backtester for Polymarket and Predict.fun crypto Up/Down markets, and for any
Polymarket binary market from your own data, in plain Python 3.10+. Read
[For AI agents](https://outcometick.github.io/polymarket-backtest/agents.html) first, or the whole documentation as one
file: [llms-full.txt](https://outcometick.github.io/polymarket-backtest/llms-full.txt).

This repository is GENERATED from the outcometick monorepo on every release; pull requests are read and ported back
by hand, so keep them small. The same engine is published for JavaScript/TypeScript at
[polymarket-backtest-js](https://github.com/outcometick/polymarket-backtest-js), with identical results.

## Layout

- `outcometick/` — the SDK (`Strategy`, `Order`) and `outcometick/backtest/` (decoder, `run`, `sweep`, `fingerprint`,
  report). `outcometick/backtest/_sandbox/` is the engine itself, the same files the hosted backtester runs.
- `examples/` — runnable strategies; `examples/templates/` — the strategy templates.
- `docs/` — methodology and verification (also the site's source); `notebooks/quickstart.ipynb`.
- `tests/` — the unit tests; `verify/` — equivalence against the npm package of the same version.

## Commands

```bash
pip install -e .                                   # or: pip install outcometick
python -m unittest discover -s tests -v            # unit tests, no network
python examples/quickstart.py                      # one free real archive day (downloaded once, then cached)
```

## Writing a strategy (the rules that decide whether a result is right)

- Subclass `Strategy`; hooks `on_market_open`, `on_tick`, `on_book`, `on_trade`, `on_timer`, `on_settle` return
  `None`, an `Order`, or a list. Run with `outcometick.backtest.run(StrategyClass, data)`.
- No look-ahead: never read archive files from inside a strategy; events arrive one at a time.
- Settlement is the official outcome, never a mark; fees are on by default (each market's schedule).
- Keep per-market state on the instance (market mode gives each market a fresh one); state on the class or in
  `params` makes parallel replay fall back to one process.
- Hold days out of a parameter search: `sweep(..., holdout=0.3)`.

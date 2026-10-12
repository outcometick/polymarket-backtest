# For AI agents

You are probably here because someone asked you to backtest a prediction-market strategy. This page is the short
path: what this package does, the smallest program that runs, the rules that decide whether a result is right, and how
to reach the data and the hosted backtester from a coding tool. The whole site as one plain-text file:
[llms-full.txt](https://outcometick.github.io/polymarket-backtest/llms-full.txt); an index:
[llms.txt](https://outcometick.github.io/polymarket-backtest/llms.txt). Every page is also served as Markdown — add `.md`
to its path (for example [methodology.md](methodology.md)).

## What it is

`outcometick.backtest` is a general tick-level backtester for Polymarket: any binary market (elections, sports,
crypto) from order-book data you recorded — Polymarket's CLOB frames or a table, see
[Your own data](index.md#your-own-data-any-polymarket-binary-market) — or a ready-made archive of Polymarket and
Predict.fun crypto Up/Down markets (5- and 15-minute on Polymarket; Predict.fun also hourly and daily), with one
free day via `load_sample()`. Each market settles at $1 / $0 only on evidence of its outcome (for the archive's
crypto markets, the Chainlink stream that market settled on), and every fill pays the venue's taker fee. Pure Python 3.10+; the same engine runs in
JavaScript (`npm i -g outcometick`, `ot run`) and on the hosted backtester, with identical results.

## Smallest program that runs

```bash
pip install outcometick
```

```python
from outcometick import Strategy, Order
from outcometick.backtest import run, load_sample


class Favourite(Strategy):
    def on_market_open(self, ctx, market):
        self.close, self.done = market.close_ts_ms, False

    def on_tick(self, ctx, tick):
        if self.done or self.close - ctx.now > 60_000:
            return None
        book = ctx.book()
        up, down = book.best("UP"), book.best("DOWN")
        if up is None or down is None:
            return None
        self.done = True
        side, price = ("UP", up) if up >= down else ("DOWN", down)
        return Order(side=side, notional=50, limit=0.95) if 0.55 <= price <= 0.95 else None


result = run(Favourite, load_sample())   # one real archive day, downloaded once, no key
print(result.summary())
```

`load_sample()` needs no account. More days come from the archive (a data subscription) unpacked to a directory and
passed as `data`.

## The shape of a strategy

- A class with hooks: `on_market_open(ctx, market)`, `on_tick(ctx, tick)` (settlement-stream price),
  `on_book(ctx, book)`, `on_trade(ctx, trade)`, `on_timer(ctx, timer)`, `on_settle(ctx, market, outcome)`.
  Declare the datasets the hooks need (`book`, `trades`, ...); `run()` infers them from the hooks you define.
- A hook returns `None`, an `Order`, or a list of them. `Order(side="UP"|"DOWN", size=... or notional=..., limit=...)`;
  `tif="gtc"` rests a limit order (Polymarket, with `book` and `trades` declared).
- `ctx`: `ctx.now`, `ctx.book()` (`best`, `best_bid`, `depth`, `levels`), `ctx.position()`, `ctx.history(n)`,
  `ctx.p` (params), `ctx.log()`, `ctx.schedule()` (timers), `ctx.spot()` / `ctx.twap_locked()` (with the `spot`
  dataset). Full reference: [outcometick.com/docs/sdk](https://outcometick.com/docs/sdk); the Python API:
  [API reference](api.md).
- By default each market gets a fresh strategy instance (`mode="market"`); `mode="session"` keeps one instance across
  markets, replayed on one time line.

## Rules that decide whether a result is right

- **No look-ahead.** Events arrive one at a time; a market's `outcome` is hidden until `on_settle`. Do not read
  archive files directly inside a strategy.
- **Settlement is never approximated.** Markets pay on the official outcome; a market whose stream or outcome cannot
  be read is dropped and listed in `report["coverage"]`, not settled on a guess.
- **Fills walk the book that was there**, level by level; size the book did not have is unfilled. Use `latency_ms`
  for order latency and `feed_latency` for when the strategy hears of an event.
- **Fees are on by default** (each market's schedule). Turn them off only on purpose.
- **Book resolution is the data's, not the engine's.** The archive's book is rebuilt from the delta stream at the
  cadence it was captured (per asset, 20-500 ms); the hosted backtester levels each asset to the coarsest cadence in
  the run's range, and `run(..., book_throttle=False)` replays the archive as captured. Your own data
  (`run(Strategy, Dataset or directory)`) is never thinned — high-frequency work belongs there.
- **Check the sample size.** One day is ~289 five-minute markets per asset. Use `sweep(..., holdout=0.3)` to keep
  later days out of a parameter search.
- **Estimates are labelled.** Queue models, maker rebates and `twap_locked()` are estimates; [Methodology](methodology.md)
  states each one's limits. [How we verify it](verification.md) says what is proven and what is not.

## From a coding tool (MCP)

The npm package includes an MCP server that runs on the user's machine (stdio, Node 24):

```bash
claude mcp add outcometick -- npx -y -p outcometick ot mcp
```

Tools: `coverage`, `plans`, `meta`, `list_files`, `download_file` (sha256-verified), `backtest_capacity`,
`backtest_quote`, `check_strategy` (the hosted queue's validator, run locally), `backtest_runs`, `backtest_status`.
Public tools need no key; `OT_KEY` (data) and `OT_BACKTEST_KEY` (hosted backtests) unlock the rest. It never submits
a backtest — that spends credits, so a person runs `ot submit`. Other clients:
[outcometick.com/docs](https://outcometick.com/docs).

## Where things are

- Python package and this repository: [github.com/outcometick/polymarket-backtest](https://github.com/outcometick/polymarket-backtest)
- JavaScript / TypeScript and the `ot` CLI: [github.com/outcometick/polymarket-backtest-js](https://github.com/outcometick/polymarket-backtest-js)
- The data these backtests replay: [Polymarket historical data](https://outcometick.com/polymarket-historical-data),
  [Polymarket order book data](https://outcometick.com/polymarket-order-book-data),
  [Chainlink settlement data](https://outcometick.com/chainlink-settlement-data),
  [Predict.fun historical data](https://outcometick.com/predict-fun-data) — the archive's own index:
  [outcometick.com/llms.txt](https://outcometick.com/llms.txt)
- Run the same strategy on our machines: [the hosted backtester](https://outcometick.com/backtest)

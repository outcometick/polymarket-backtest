<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick backtest

**Tick-level backtesting for Polymarket and Predict.fun crypto Up/Down markets.** Your strategy is replayed
against the archived order book, settled at $1 / $0 on the Chainlink stream each market actually settled on,
and charged the venue's taker fee. Write it in Python or JavaScript; run it on your laptop or on the
[hosted backtester](https://outcometick.com/backtest). Both run the same engine under the same rules, and this
repository holds the tests that compare the implementations.

[简体中文](README.zh-CN.md) · [Methodology](docs/methodology.md) · [How we verify it](docs/verification.md) ·
[SDK reference](https://outcometick.com/docs/sdk)

```bash
pip install outcometick        # Python 3.10+, no other dependencies
```

```python
from outcometick import Strategy, Order
from outcometick.backtest import run, load_sample


class Favourite(Strategy):
    """Buy the favourite in the last minute, if it is not already priced as a certainty."""

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
        if not 0.55 <= price <= 0.95:
            return None
        return Order(side=side, notional=50, limit=0.95)


result = run(Favourite, load_sample())   # one real archive day, downloaded once, no key
print(result.summary())
result.plot()                            # needs matplotlib
```

JavaScript, with the `ot` command line (Node 24):

```bash
npm i -g outcometick
ot init my-strategy --template favourite-near-close --lang nodejs
curl -L https://github.com/outcometick/polymarket-tick-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz
ot run my-strategy --data ./polymarket-data-samples
```

## What it gets right

**Settlement is the venue's, not an approximation.** A Polymarket crypto market settles on one Chainlink
stream — the instantaneous feed, a 30-second TWAP or a 60-second TWAP — and which one is stated in that
market's own config (`twapLookbackSeconds`), not implied by its date. Every market is replayed against its own
stream and pays $1 or $0 from the official outcome. Predict.fun ties pay 50:50. A market whose stream or outcome
cannot be read is dropped and listed in the report, never settled on a guess.

**Two order books per market.** UP and DOWN are separate tokens with separate bids and asks. Buying UP lifts
UP's asks; getting out sells into UP's bids. (Predict.fun publishes one book per market, so its DOWN side is the
mirror of UP's.)

**Fills walk the depth that was there.** An order is matched against the reconstructed book at that
millisecond, level by level. Size the book did not have is reported as unfilled — it is never filled at the top
of book. With `latency_ms`, the order matches against the book as it stood when it would have arrived, and a
limit still protects it.

**The venue's taker fee, market by market.** Polymarket charges takers `C × rate × p × (1 − p)`; each market's
schedule is in the archive, and every simulated fill pays it. The report states the fee model used and how many
markets had no readable schedule. It is an estimate in one respect, and the report says so: the venue rounds
per maker order matched, the archive keeps book levels, so the fee is computed and rounded per level taken.

**No look-ahead by construction.** Events reach the strategy one at a time; the rest of the day is not in
memory. A market's `outcome` is hidden until `on_settle`. In session mode, markets that overlap in time are
replayed interleaved in one time order, so state carried across markets never runs ahead of the clock.

**One engine, two languages, local and hosted.** The Python and JavaScript engines are checked against each
other trade by trade. The pure-Python runner is checked against the command line — which shares its decoder,
engine and report with the hosted queue — event by event and row by row, on the public archive samples and on
synthetic archives built to hold the awkward cases. See [How we verify it](docs/verification.md).

**A report made for binary markets.** Brier score, calibration by entry price, edge per contract, peak capital
at risk, a slippage panel, and naive baselines at the same trade size — always UP, always DOWN, always the
favourite at the opening quote. If a strategy cannot beat buying the favourite, the report says so on page one.

**Honest about the data.** The book is rebuilt from snapshots and deltas captured at a set cadence; the
unthrottled best-bid/ask stream can only remove levels the market has moved past, never add one. Every
market-day that could not be replayed is listed with the reason. [Methodology](docs/methodology.md) has the
details.

**Plain classes.** No special dialect, no compilation step: `on_market_open`, `on_tick`, `on_book`, `on_trade`,
`on_settle`, returning an `Order` or nothing. The same class runs here and in the hosted sandbox.

## How a run works

```
  archive (gzip JSONL / CSV, as published)
      │  decode: markets → each market's settlement stream, book, deltas, trades;
      │  the book stream thinned to one cadence per asset; same-millisecond order fixed
      ▼
  one event stream per market (session mode: one stream across markets, by time)
      │  pulled one event at a time
      ▼
  engine: order book (UP + DOWN) ── your strategy's hooks ── orders (IOC, latency, limit)
      │  fills walk the depth · venue taker fee · settlement $1 / $0 at the official outcome
      ▼
  report: PnL, Brier, calibration, baselines, slippage, fee model, coverage of what ran
```

## Data

- **Free sample:** one real archive day per venue — `load_sample("polymarket")`, `load_sample("predict")` —
  also on [GitHub Releases](https://github.com/outcometick/polymarket-tick-data-samples), Kaggle and Hugging Face.
- **Full archive:** a [subscription](https://outcometick.com) downloads the same files for any day; point
  `run()` at the unpacked directory. `outcometick.data` (Python) and `outcometick/data` (Node) fetch them.
- **No download at all:** the [hosted backtester](https://outcometick.com/backtest) runs the same strategy over
  recent days on our runner and returns the report.

## Limits

- Orders take liquidity (IOC). Resting limit orders need a queue-position model; a guessed one inflates
  market-making returns, so they are refused rather than approximated. A conservative queue model is next.
- 5-minute and 15-minute crypto Up/Down markets, the ones the archive holds.
- The Binance reference feed lives on the hosted runner, not in the archive, so strategies that read it run
  there. Your own CSV series (`series`, read with `ctx.ext()`) run with `ot run` and hosted; the Python runner
  refuses them for now rather than replaying without them.
- One sample day says nothing about next month. Backtest over a range before trusting any number.

## This repository

| path | what |
| --- | --- |
| `python/` | the `outcometick` PyPI package: SDK, data client, `outcometick.backtest`, tests |
| `typescript/` | the `outcometick` npm package: SDK, the `ot` CLI, the JavaScript engine, tests |
| `examples/` | runnable strategies in both languages |
| `notebooks/` | the quick start as a notebook, with its output |
| `docs/` | methodology and verification |

Generated from the outcometick monorepo, where the engines also run the hosted backtester; packages are
released from [outcometick-sdk-python](https://github.com/outcometick/outcometick-sdk-python) and
[outcometick-sdk-ts](https://github.com/outcometick/outcometick-sdk-ts). Issues and pull requests are welcome
here.

License: MIT.

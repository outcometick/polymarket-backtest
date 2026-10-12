"""Cap open positions across overlapping markets in session mode.

One strategy instance and one clock serve all markets, with events interleaved
in time order. A 15-minute market can overlap three 5-minute markets.
"""

from outcometick import Order, Strategy
from outcometick.backtest import load_sample, run


class CappedFavourite(Strategy):
    params = {"max_open": 3, "notional": 30}

    def on_market_open(self, ctx, market):
        # One instance serves every market, so per-market facts are keyed by id.
        if not hasattr(self, "open_markets"):
            self.open_markets, self.closes = set(), {}
        self.closes[market.market_id] = market.close_ts_ms

    def on_tick(self, ctx, tick):
        mid = tick.market_id
        if mid in self.open_markets or len(self.open_markets) >= ctx.p.max_open:
            return None
        if self.closes[mid] - ctx.now > 90_000:
            return None
        book = ctx.book()
        up, down = book.best("UP"), book.best("DOWN")
        if up is None or down is None:
            return None
        side, price = ("UP", up) if up >= down else ("DOWN", down)
        if not 0.6 <= price <= 0.9:
            return None
        self.open_markets.add(mid)
        return Order(side=side, notional=ctx.p.notional, limit=price)

    def on_settle(self, ctx, market, outcome):
        self.open_markets.discard(market.market_id)
        self.closes.pop(market.market_id, None)


if __name__ == "__main__":
    result = run(CappedFavourite, load_sample("polymarket"), mode="session", intervals=["5m", "15m"])
    print(result.summary())

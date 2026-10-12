"""Buy the favourite in the last minute when its ask is within the entry range.

    pip install outcometick
    python quickstart.py
"""

from outcometick import Order, Strategy
from outcometick.backtest import load_sample, run


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
        if not 0.55 <= price <= 0.95:
            return None
        return Order(side=side, notional=50, limit=0.95)


if __name__ == "__main__":
    result = run(Favourite, load_sample("polymarket"))
    print(result.summary())

"""Quote both sides of a Polymarket Up/Down market and see what the fills were worth.

Two resting bids: UP at the best bid, and DOWN at one minus the best ask (buying
DOWN at 1 - a is offering UP at a — the mirrored book makes them one market).
Both are re-quoted when the touch moves (at most once a second: a cancel stays
exposed for a short window after it lands, so chasing every flicker of the
touch mostly buys that exposure), and inventory is closed with a resting
reduce-only order one tick through the entry.

The report's maker block is the point: fill rate, where in the queue the fills
came from, and the markouts — the mid 1s / 10s / 60s after each fill, against
the fill price. Consistently negative markouts are adverse selection: the
fills you got were the ones you should not have wanted.
"""

from outcometick import Order, Strategy
from outcometick.backtest import load_sample, run

TICK = 0.001
REQUOTE_MS = 1000


def on_grid(x):
    return round(round(x / TICK) * TICK, 3)


class TwoSidedQuote(Strategy):
    def on_market_open(self, ctx, market):
        self.quoted = None  # (bid, ask) we are working
        self.last_quote = None

    def on_book(self, ctx, ev):
        book = ctx.book()
        bid, ask = book.best_bid("UP"), book.best("UP")
        if bid is None or ask is None or not 0.05 < bid < ask < 0.95:
            return None
        if self.quoted == (bid, ask) or (self.last_quote is not None and ctx.now - self.last_quote < REQUOTE_MS):
            return None
        # Re-quote: cancel everything working, then quote both sides again and
        # re-place the exit — all priced off the same book, so none of the new
        # orders cross each other (one mirrored queue: the engine would refuse).
        self.last_quote = ctx.now
        self.quoted = (bid, ask)
        for o in ctx.orders():
            if o.state == "live":
                ctx.cancel(o.id)
        orders = [
            Order(side="UP", size=25, limit=on_grid(bid), tif="gtc", post_only=True),
            Order(side="DOWN", size=25, limit=on_grid(1 - ask), tif="gtc", post_only=True),
        ]
        pos = ctx.position()
        token_ask = book.best(pos.side) if pos.side else None
        if pos.size > 0 and token_ask is not None:
            # Exit passively: at least a tick above the entry, never below the
            # token's own best ask.
            px = on_grid(min(0.99, max(pos.avg_entry + TICK, token_ask)))
            orders.append(Order(side=pos.side, size=pos.size, limit=px, tif="gtc", reduce_only=True))
        return orders

if __name__ == "__main__":
    result = run(TwoSidedQuote, load_sample("polymarket"), assets=["BTC"],
                 datasets=["settlement", "book", "trades"], latency_ms=150, cancel_latency_ms=100)
    print(result.summary())
    mk = result.report["maker"]
    print(f"rested {mk['orders']['rested']} orders, maker fill rate {mk['fill_rate_size']} by size")
    print(f"median queue ahead at join {mk['median_ahead_at_join']}, at fill {mk['median_ahead_at_fill']}")
    for h in ("1s", "10s", "60s", "settle"):
        m = mk["markout"][h]
        print(f"markout {h:>6}: {m['mean']} per share over {m['fills']} fills")

"""Buy the side favoured by the settlement feed near market close.

Compare tick.value with market.strike (the opening price) during the last
enter_at_s seconds, and buy when the lead and ask meet the entry thresholds.
"""

from outcometick import Order, Strategy
from outcometick.backtest import load_sample, run


class SettlementLead(Strategy):
    params = {"enter_at_s": 60, "min_lead_bps": 2, "px_min": 0.55, "px_max": 0.95, "notional": 50}

    def on_market_open(self, ctx, market):
        self.strike, self.close, self.entry = market.strike, market.close_ts_ms, None

    def on_tick(self, ctx, tick):
        if self.entry is not None or self.strike is None:
            return None
        secs_left = (self.close - ctx.now) / 1000
        if secs_left > ctx.p.enter_at_s or secs_left <= 0:
            return None
        lead_bps = (tick.value - self.strike) / self.strike * 10_000
        if abs(lead_bps) < ctx.p.min_lead_bps:
            return None
        side = "UP" if lead_bps > 0 else "DOWN"
        ask = ctx.book().best(side)
        if ask is None or not ctx.p.px_min <= ask <= ctx.p.px_max:
            return None
        self.entry = (side, ask)
        return Order(side=side, notional=ctx.p.notional, limit=ask)

    def on_settle(self, ctx, market, outcome):
        if self.entry:
            ctx.log(f"{market.asset} {market.interval}: bought {self.entry[0]} @ {self.entry[1]:.3f}, settled {outcome}")


if __name__ == "__main__":
    for venue in ("polymarket", "predict"):
        result = run(SettlementLead, load_sample(venue))
        print(f"\n{venue}\n{result.summary()}")

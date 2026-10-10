"""How much of a result survives fees and a realistic delay?

The same strategy three ways: gross (no fees), with the venue's taker fee, and
with the fee plus 250 ms between decision and fill.
"""

from outcometick.backtest import load_sample, run

from settlement_lead import SettlementLead

if __name__ == "__main__":
    data = load_sample("polymarket")
    for label, kw in [
        ("gross, instant", {"fee_bps": 0}),
        ("venue fee, instant", {}),
        ("venue fee, +250 ms", {"latency_ms": 250}),
    ]:
        m = run(SettlementLead, data, **kw).metrics
        print(f"{label:<22} net {m['net_pnl']:>9.2f}   fees {m['fees']:>8.2f}   trades {m['trades']:>4}")

// A small synthetic archive, laid out and spelled exactly like the real one,
// built to contain the cases the public samples do not: a market crossing
// midnight, a market with no settlement ticks, an unresolved one, a TIE, fees
// off and unreadable, a market on the 30s TWAP, five kinds of event on one
// millisecond, a price_change stream dense enough to be thinned, best_bid_ask
// bounds that delete levels, an empty file, a Predict feed id that belongs to
// no market.
//
// Used by client/backtest/equivalence.test.mjs, which decodes and replays it
// through the JS (queue / `ot run`) path and through the pure-Python package
// and requires the same answer. Row shapes copied from the 2026-09-08 sample.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const DAY1 = '2026-09-08';
const DAY2 = '2026-09-09';
const T0 = Date.parse(`${DAY1}T00:00:00Z`);       // 1788825600000
const T1 = Date.parse(`${DAY2}T00:00:00Z`);
const MIN = 60_000;

const jsonl = (rows) => gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')));
const csv = (header, rows) => gzipSync(Buffer.from([header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n'));

async function put(root, rel, bytes) {
  const full = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
}

/** A deterministic stream of small integers, so a fixture never changes. */
function lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}

const tok = (n) => String(10n ** 70n + BigInt(n));      // token ids are 77-digit decimal strings

function pmMarket({ slug, asset, intervalSec, cond, start, end, outcome, lookback = 60, fee = 'on' }) {
  const ups = tok(cond * 2);
  const downs = tok(cond * 2 + 1);
  const raw = {
    slug,
    cryptoMarketConfig: { id: `${asset}-x`, asset, twapEnabled: true, twapLookbackSeconds: lookback },
    feeType: 'crypto_fees_v2',
    orderPriceMinTickSize: 0.001,
  };
  if (fee === 'on') Object.assign(raw, { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 } });
  if (fee === 'off') Object.assign(raw, { feesEnabled: false });
  if (fee === 'odd') Object.assign(raw, { feesEnabled: true, feeSchedule: { rate: 0.25, exponent: 2, takerOnly: true } });
  return {
    row: {
      slug,
      asset,
      interval_sec: intervalSec,
      condition_id: `0x${String(cond).padStart(64, '0')}`,
      token_ids: [ups, downs],
      start_sec: start / 1000,
      end_sec: end / 1000,
      resolved: outcome != null,
      outcome_prices: outcome === 'UP' ? ['1', '0'] : outcome === 'DOWN' ? ['0', '1'] : ['0.5', '0.5'],
      strike_value: '79104869058460346482688',
      raw,
    },
    up: ups,
    down: downs,
    slug,
    start,
    end,
  };
}

/** Book, price_change, best_bid_ask and trades for one Polymarket market. */
function pmStreams(m, rnd, { stepMs = 7_000 } = {}) {
  const book = [];
  const pc = [];
  const bbo = [];
  const trades = [];
  let mid = 0.5;
  for (let ts = m.start + 50; ts < m.end; ts += stepMs) {
    mid = Math.min(0.97, Math.max(0.03, Number((mid + (rnd() - 0.5) * 0.06).toFixed(2))));
    const levels = (center, dir) => Array.from({ length: 4 }, (_, i) => ({
      price: String(Number((center + dir * (0.01 + i * 0.01)).toFixed(2))),
      size: String(Number((20 + rnd() * 200).toFixed(2))),
    }));
    for (const [asset, c] of [[m.up, mid], [m.down, Number((1 - mid).toFixed(2))]]) {
      book.push({
        slug: m.slug, asset_id: asset, event_type: 'book', event_ts_ms: ts, recv_ms: ts + 9,
        payload: { asks: levels(c, 1).reverse(), bids: levels(c, -1), market: '0xm', asset_id: asset },
      });
    }
    // A burst of deltas, thinned to one per window by the cadence rule (20 ms
    // for BTC on these days), so the two decoders have to keep the same rows —
    // including the ones landing EXACTLY on a window edge, where `<` and `<=`
    // disagree.
    const burst = [0, 5, 10, 15, 20, 25, 40, 59, 60];
    for (let j = 0; j < burst.length; j += 1) {
      const t = ts + 300 + burst[j];
      pc.push({
        slug: m.slug, asset_id: null, event_type: 'price_change', event_ts_ms: t, recv_ms: t + 7,
        payload: {
          market: '0xm', event_type: 'price_change',
          price_changes: [
            { side: 'SELL', price: String(Number((mid + 0.01).toFixed(2))), size: j === 3 ? '0' : String(10 + j), asset_id: m.up, best_bid: String(Number((mid - 0.01).toFixed(2))), best_ask: String(Number((mid + 0.01).toFixed(2))) },
            { side: 'BUY', price: String(Number((1 - mid - 0.01).toFixed(2))), size: String(5 + j), asset_id: m.down, best_bid: '0.4', best_ask: '0.6' },
            { side: 'BUY', price: '0.5', size: '1', asset_id: 'not-a-token-of-this-market' },
          ],
        },
      });
    }
    // A bound that has moved past the best ask: deletes, never adds.
    bbo.push({
      slug: m.slug, asset_id: m.up, event_type: 'best_bid_ask', event_ts_ms: ts + 1200, recv_ms: ts + 1210,
      payload: { asset_id: m.up, best_bid: String(Number((mid - 0.01).toFixed(2))), best_ask: String(Number((mid + 0.02).toFixed(2))) },
    });
    trades.push({
      slug: m.slug, asset_id: rnd() < 0.5 ? m.up : m.down, event_type: 'last_trade_price', event_ts_ms: ts + 2000, recv_ms: ts + 2010,
      payload: { side: rnd() < 0.5 ? 'BUY' : 'SELL', size: String(Number((1 + rnd() * 30).toFixed(4))), price: String(mid) },
    });
  }
  // Five kinds of event on ONE millisecond: the tie order is part of the contract.
  const same = m.start + 100_000;
  book.push({ slug: m.slug, asset_id: m.up, event_type: 'book', event_ts_ms: same, recv_ms: same, payload: { asks: [{ price: '0.62', size: '40' }], bids: [{ price: '0.58', size: '40' }] } });
  pc.push({ slug: m.slug, asset_id: null, event_type: 'price_change', event_ts_ms: same, recv_ms: same, payload: { price_changes: [{ side: 'SELL', price: '0.63', size: '25', asset_id: m.up }] } });
  bbo.push({ slug: m.slug, asset_id: m.up, event_type: 'best_bid_ask', event_ts_ms: same, recv_ms: same, payload: { best_bid: '0.58', best_ask: '0.62' } });
  trades.push({ slug: m.slug, asset_id: m.up, event_type: 'last_trade_price', event_ts_ms: same, recv_ms: same, payload: { side: 'BUY', size: '3', price: '0.62' } });
  const sortTs = (a, b) => a.event_ts_ms - b.event_ts_ms;
  return { book: book.sort(sortTs), pc: pc.sort(sortTs), bbo: bbo.sort(sortTs), trades: trades.sort(sortTs) };
}

function settlementRows(from, to, rnd, stepMs = 1000) {
  const rows = [];
  let v = 79100;
  for (let ts = from; ts <= to; ts += stepMs) {
    v = Number((v + (rnd() - 0.5) * 8).toFixed(6));
    rows.push([ts, v, '79104869058460346482688', ts + 900, ts + 1100]);
  }
  return rows;
}

/** Build the Polymarket fixture under `root`. Returns the root. */
export async function buildPolymarketFixture(root) {
  const rnd = lcg(42);
  const D1 = (h, m = 0) => T0 + h * 3_600_000 + m * MIN;
  const markets1 = {
    'BTC-5m': [
      pmMarket({ slug: 'btc-updown-5m-a', asset: 'btc', intervalSec: 300, cond: 1, start: D1(0, 0), end: D1(0, 5), outcome: 'UP' }),
      pmMarket({ slug: 'btc-updown-5m-b', asset: 'btc', intervalSec: 300, cond: 2, start: D1(0, 5), end: D1(0, 10), outcome: 'DOWN', fee: 'off' }),
      pmMarket({ slug: 'btc-updown-5m-c', asset: 'btc', intervalSec: 300, cond: 3, start: D1(0, 10), end: D1(0, 15), outcome: 'UP', fee: 'odd' }),
      pmMarket({ slug: 'btc-updown-5m-d', asset: 'btc', intervalSec: 300, cond: 4, start: D1(0, 15), end: D1(0, 20), outcome: null }),
      pmMarket({ slug: 'btc-updown-5m-e', asset: 'btc', intervalSec: 300, cond: 5, start: D1(0, 20), end: D1(0, 25), outcome: 'DOWN', lookback: 30, fee: 'missing' }),
    ],
    'BTC-15m': [
      pmMarket({ slug: 'btc-updown-15m-a', asset: 'btc', intervalSec: 900, cond: 11, start: D1(0, 0), end: D1(0, 15), outcome: 'DOWN' }),
      // Crosses midnight into DAY2: listed in both days' markets files.
      pmMarket({ slug: 'btc-updown-15m-x', asset: 'btc', intervalSec: 900, cond: 12, start: D1(23, 50), end: D1(23, 50) + 15 * MIN, outcome: 'UP' }),
    ],
    // No ETH settlement file at all: every ETH market is unusable.
    'ETH-5m': [
      pmMarket({ slug: 'eth-updown-5m-a', asset: 'eth', intervalSec: 300, cond: 21, start: D1(0, 0), end: D1(0, 5), outcome: 'UP' }),
    ],
  };
  const files = {};
  for (const [group, ms] of Object.entries(markets1)) {
    files[`data/polymarket/daily/markets/${group}/${group}-markets-${DAY1}.jsonl.gz`] = jsonl(ms.map((m) => m.row));
    const all = { book: [], pc: [], bbo: [], trades: [] };
    for (const m of ms) {
      const s = pmStreams(m, rnd);
      for (const k of Object.keys(all)) all[k].push(...s[k].filter((r) => r.event_ts_ms < T1));
    }
    const by = (k) => all[k].sort((a, b) => a.event_ts_ms - b.event_ts_ms);
    files[`data/polymarket/daily/book/${group}/${group}-book-${DAY1}.jsonl.gz`] = jsonl(by('book'));
    files[`data/polymarket/daily/price_change/${group}/${group}-price_change-${DAY1}.jsonl.gz`] = jsonl(by('pc'));
    files[`data/polymarket/daily/best_bid_ask/${group}/${group}-best_bid_ask-${DAY1}.jsonl.gz`] = jsonl(by('bbo'));
    files[`data/polymarket/daily/last_trade_price/${group}/${group}-last_trade_price-${DAY1}.jsonl.gz`] = jsonl(group === 'BTC-15m' ? [] : by('trades'));
  }
  // DAY2: the crossing market again, plus one more.
  const x = markets1['BTC-15m'][1];
  const day2 = [x, pmMarket({ slug: 'btc-updown-15m-y', asset: 'btc', intervalSec: 900, cond: 13, start: T1 + 5 * MIN, end: T1 + 20 * MIN, outcome: 'UP' })];
  files[`data/polymarket/daily/markets/BTC-15m/BTC-15m-markets-${DAY2}.jsonl.gz`] = jsonl(day2.map((m) => m.row));
  const d2 = { book: [], pc: [], bbo: [], trades: [] };
  for (const m of day2) {
    const s = pmStreams(m, lcg(m.end));
    for (const k of Object.keys(d2)) d2[k].push(...s[k].filter((r) => r.event_ts_ms >= T1));
  }
  // The crossing market's DAY1 rows went into the DAY1 files above; these
  // are its rows after midnight.
  const merge = (k) => d2[k].sort((a, b) => a.event_ts_ms - b.event_ts_ms);
  files[`data/polymarket/daily/book/BTC-15m/BTC-15m-book-${DAY2}.jsonl.gz`] = jsonl(merge('book'));
  files[`data/polymarket/daily/price_change/BTC-15m/BTC-15m-price_change-${DAY2}.jsonl.gz`] = jsonl(merge('pc'));
  files[`data/polymarket/daily/best_bid_ask/BTC-15m/BTC-15m-best_bid_ask-${DAY2}.jsonl.gz`] = jsonl(merge('bbo'));
  files[`data/polymarket/daily/last_trade_price/BTC-15m/BTC-15m-last_trade_price-${DAY2}.jsonl.gz`] = jsonl(merge('trades'));

  // Settlement streams. twap60s for both days; twap30s for DAY1 (market e);
  // the instantaneous stream too, which no market settles on and so must not
  // be fed at all. No ETH file anywhere.
  const head = ['feed_ts_ms', 'value', 'full_accuracy_value', 'server_ts_ms', 'recv_ms'];
  files[`data/chainlink-twap-60s/daily/prices/BTCUSD/BTCUSD-twap60s-prices-${DAY1}.csv.gz`] = csv(head, settlementRows(T0, T1 - 1000, lcg(7)));
  files[`data/chainlink-twap-60s/daily/prices/BTCUSD/BTCUSD-twap60s-prices-${DAY2}.csv.gz`] = csv(head, settlementRows(T1, T1 + 3_600_000, lcg(8)));
  files[`data/chainlink-twap-30s/daily/prices/BTCUSD/BTCUSD-twap30s-prices-${DAY1}.csv.gz`] = csv(head, settlementRows(T0, T0 + 3_600_000, lcg(9)));
  files[`data/chainlink/daily/prices/BTCUSD/BTCUSD-prices-${DAY1}.csv.gz`] = csv(head, settlementRows(T0, T0 + 600_000, lcg(10), 500));
  for (const [rel, bytes] of Object.entries(files)) await put(root, rel, bytes);
  return root;
}

/** Build the Predict.fun fixture under `root`. Returns the root. */
export async function buildPredictFixture(root) {
  const rnd = lcg(99);
  const mk = (id, slug, start, end, sp, ep, feed = 1, label = '5m') => ({
    category_slug: slug, asset: 'btc', interval_label: label, market_id: id,
    price_feed_id: feed, price_feed_symbol: 'BTCUSDT', price_feed_provider: 'CHAINLINK',
    condition_id: `0x${String(id).padStart(64, 'a')}`, start_sec: start / 1000, end_sec: end / 1000,
    start_price: sp, end_price: ep, status: 'OPEN',
  });
  const markets = [
    mk(1001, 'btc-updown-5m-p1', T0, T0 + 5 * MIN, '79100.5', '79120.25'),
    mk(1002, 'btc-updown-5m-p2', T0 + 5 * MIN, T0 + 10 * MIN, '79120.25', '79120.25'),     // TIE
    mk(1003, 'btc-updown-5m-p3', T0 + 10 * MIN, T0 + 15 * MIN, '79120.25', null),          // not settled
    mk(1004, 'btc-updown-5m-p4', T0 + 15 * MIN, T0 + 20 * MIN, '79110', '79090', 7),       // feed nobody publishes
    mk(1005, 'btc-updown-15m-p5', T0, T0 + 15 * MIN, '79100.5', '79080', 1, '15m'),
  ];
  const books = [];
  for (const m of markets) {
    let mid = 0.5;
    for (let ts = m.start_sec * 1000 + 30; ts < m.end_sec * 1000; ts += 3_000) {
      mid = Math.min(0.97, Math.max(0.03, Number((mid + (rnd() - 0.5) * 0.05).toFixed(2))));
      const lv = (c, dir) => Array.from({ length: 5 }, (_, i) => [Number((c + dir * (0.01 + 0.01 * i)).toFixed(2)), Number((10 + rnd() * 90).toFixed(3))]);
      books.push({
        market_id: m.market_id, category_slug: m.category_slug, update_ts_ms: ts, recv_ms: ts + 40,
        payload: { asks: lv(mid, 1), bids: lv(mid, -1), version: 1 },
      });
    }
  }
  books.sort((a, b) => a.update_ts_ms - b.update_ts_ms);
  const files = {
    [`data/predict-fun/markets/predict-markets-${DAY1}.jsonl.gz`]: jsonl(markets),
    [`data/predict-fun/orderbook/BTC-5M/BTC-5M-predict-orderbook-${DAY1}.jsonl.gz`]: jsonl(books.filter((b) => b.category_slug.includes('-5m-'))),
    [`data/predict-fun/orderbook/BTC-15M/BTC-15M-predict-orderbook-${DAY1}.jsonl.gz`]: jsonl(books.filter((b) => b.category_slug.includes('-15m-'))),
    // An empty file for a day that has nothing: decoded as nothing, in both.
    [`data/predict-fun/orderbook/BTC-HOURLY/BTC-HOURLY-predict-orderbook-${DAY1}.jsonl.gz`]: jsonl([]),
  };
  const head = ['price_feed_id', 'symbol', 'provider', 'publish_time', 'server_ts', 'price', 'recv_ms'];
  const prices = [];
  let v = 79100;
  for (let s = T0 / 1000; s <= T0 / 1000 + 1800; s += 1) {
    v = Number((v + (rnd() - 0.5) * 6).toFixed(3));
    prices.push([1, 'BTCUSDT', 'CHAINLINK', s, s + 1, v, s * 1000 + 1100]);
  }
  files[`data/predict-fun/prices/BTCUSDT/BTCUSDT-feed1-predict-prices-${DAY1}.csv.gz`] = csv(head, prices);
  for (const [rel, bytes] of Object.entries(files)) await put(root, rel, bytes);
  return root;
}

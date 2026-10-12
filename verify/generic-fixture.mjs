// Fixed-seed generic dataset for cross-language comparisons: frame forms,
// resolution sources, unresolved marks, refusal rules, mid-stream windows,
// event ties, gzip and malformed lines.

import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

export const T0 = 1_760_000_000_000;

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const px = (v) => Math.min(0.99, Math.max(0.01, Math.round(v * 100) / 100));
const lv = (levels) => levels.map(([p, s]) => ({ price: String(p), size: String(s) }));

/** One market's frames: a random walk of books, deltas, trades and bounds. */
function walk({ market, up, down, start, n, seed, archiveRows = false, bbo = false }) {
  const r = rng(seed);
  let mid = 0.35 + r() * 0.3;
  const out = [];
  const frame = (f, t) => {
    if (!archiveRows) return { ...f, timestamp: String(t) };
    // The outcometick archive's row shape: the frame under `payload`, times beside it.
    return { slug: undefined, asset_id: f.asset_id, event_type: f.event_type, event_ts_ms: t, recv_ms: t + 7, payload: { ...f, timestamp: String(t) } };
  };
  const snapshot = (t) => {
    const a = px(mid + 0.01);
    const b = px(mid - 0.01);
    out.push(frame({ event_type: 'book', market, asset_id: up, bids: lv([[b, 50 + Math.floor(r() * 50)], [px(b - 0.01), 80]]), asks: lv([[a, 40 + Math.floor(r() * 50)], [px(a + 0.01), 90]]) }, t));
    out.push(frame({ event_type: 'book', market, asset_id: down, bids: lv([[px(1 - a), 45], [px(1 - a - 0.01), 70]]), asks: lv([[px(1 - b), 55], [px(1 - b + 0.01), 60]]) }, t));
  };
  snapshot(start);
  let t = start;
  for (let i = 0; i < n; i += 1) {
    // Several events share a millisecond now and then.
    t += r() < 0.15 ? 0 : 1 + Math.floor(r() * 900);
    const k = r();
    if (k < 0.05) {
      mid = Math.min(0.9, Math.max(0.1, mid + (r() - 0.5) * 0.06));
      snapshot(t);
    } else if (k < 0.7) {
      mid = Math.min(0.9, Math.max(0.1, mid + (r() - 0.5) * 0.02));
      const s = Math.floor(r() * 120);
      out.push(frame({
        event_type: 'price_change', market,
        price_changes: [
          { asset_id: up, price: String(px(mid + (r() < 0.5 ? 0.01 : -0.01))), size: String(s), side: r() < 0.5 ? 'BUY' : 'SELL' },
          { asset_id: down, price: String(px(1 - mid)), size: String(Math.floor(r() * 120)), side: r() < 0.5 ? 'BUY' : 'SELL' },
        ],
      }, t));
    } else if (k < 0.9) {
      const side = r() < 0.6 ? up : down;
      const p = side === up ? px(mid + (r() - 0.5) * 0.02) : px(1 - mid + (r() - 0.5) * 0.02);
      out.push(frame({ event_type: 'last_trade_price', market, asset_id: side, price: String(p), size: String(1 + Math.floor(r() * 60)), side: r() < 0.5 ? 'BUY' : 'SELL', fee_rate_bps: '0' }, t));
    } else if (bbo) {
      const a = px(mid + 0.01 + (r() < 0.3 ? 0.01 : 0));
      out.push(frame({ event_type: 'best_bid_ask', market, asset_id: up, best_bid: String(px(mid - 0.01)), best_ask: String(a), spread: '0.02' }, t));
    }
  }
  return { frames: out, end: t };
}

const gammaOf = ({ id, slug, up, down, labels = ['Yes', 'No'], extra = {} }) => ({
  conditionId: id, slug, question: `${slug}?`, clobTokenIds: JSON.stringify([up, down]),
  outcomes: JSON.stringify(labels), outcomePrices: '["0.5","0.5"]', active: true, closed: false,
  feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 },
  orderPriceMinTickSize: 0.01, orderMinSize: 5, ...extra,
});

export async function buildGenericFixture(dir) {
  await mkdir(path.join(dir, 'frames', 'b'), { recursive: true });
  const markets = [];
  const files = { a: [], b: [], c: [] };
  const iso = (ms) => new Date(ms).toISOString();

  // 1. Resolved by Gamma (umaEndDate after the data), fee schedule, archive-row frames + bbo.
  const m1 = walk({ market: '0xm1', up: 'u1', down: 'd1', start: T0, n: 900, seed: 11, archiveRows: true, bbo: true });
  markets.push(gammaOf({ id: '0xm1', slug: 'm1', up: 'u1', down: 'd1', extra: { umaResolutionStatus: 'resolved', outcomePrices: '["1","0"]', umaEndDate: iso(m1.end + 120_000) } }));
  files.a.push(...m1.frames);

  // 2. Resolved by a market_resolved frame mid-data: everything after it is dropped.
  const m2 = walk({ market: '0xm2', up: 'u2', down: 'd2', start: T0 + 30, n: 900, seed: 12 });
  const cut = m2.frames[Math.floor(m2.frames.length * 0.7)].timestamp;
  m2.frames.push({ event_type: 'market_resolved', market: '0xm2', winning_asset_id: 'd2', winning_outcome: 'Celtics', timestamp: cut });
  markets.push({ market_id: '0xm2', slug: 'm2', token_ids: ['u2', 'd2'], labels: ['Lakers', 'Celtics'], fee: { model: 'none' } });
  files.b.push(...m2.frames);

  // 3. Explicit TIE resolution, a declared trading end, a window opening mid-stream.
  const m3 = walk({ market: '0xm3', up: 'u3', down: 'd3', start: T0, n: 700, seed: 13 });
  markets.push({ market_id: '0xm3', slug: 'm3', token_ids: ['u3', 'd3'], labels: ['Up', 'Down'],
    start_ts_ms: T0 + 60_000, trading_end_ts_ms: m3.end - 30_000,
    resolution: { outcome: 'TIE', resolved_ts_ms: m3.end + 5_000 }, gamma: gammaOf({ id: '0xm3', slug: 'm3x', up: 'u3', down: 'd3', labels: ['Up', 'Down'] }) });
  files.a.push(...m3.frames);

  // 4. Unresolved, marked at its own mid. 5. Unresolved, its UP book emptied, marked off DOWN or the last trade.
  const m4 = walk({ market: '0xm4', up: 'u4', down: 'd4', start: T0 + 30, n: 600, seed: 14, bbo: true });
  markets.push(gammaOf({ id: '0xm4', slug: 'm4', up: 'u4', down: 'd4' }));
  files.c.push(...m4.frames);
  const m5 = walk({ market: '0xm5', up: 'u5', down: 'd5', start: T0 + 30, n: 400, seed: 15 });
  m5.frames.push({ event_type: 'book', market: '0xm5', asset_id: 'u5', bids: [], asks: [], timestamp: String(m5.end + 1) });
  markets.push(gammaOf({ id: '0xm5', slug: 'm5', up: 'u5', down: 'd5', extra: { feesEnabled: false } }));
  files.b.push(...m5.frames);

  // Refused markets, one per rule.
  const refuse = (id, frames, entry = {}) => {
    markets.push({ market_id: id, token_ids: [`${id}u`, `${id}d`], labels: ['Yes', 'No'], ...entry });
    files.c.push(...frames);
  };
  const okBook = (id, t) => ({ event_type: 'book', market: id, asset_id: `${id}u`, bids: lv([[0.4, 10]]), asks: lv([[0.5, 10]]), timestamp: String(t) });
  refuse('0xr1', [okBook('0xr1', T0), { event_type: 'book', market: '0xr1', asset_id: '0xr1u', bids: lv([[0.4, 10], [0.4, 5]]), asks: [], timestamp: String(T0 + 9) }]);
  refuse('0xr2', [okBook('0xr2', T0), { event_type: 'book', market: '0xr2', asset_id: 'u1', bids: [], asks: [], timestamp: String(T0 + 9) }]);
  refuse('0xr3', [okBook('0xr3', T0), { event_type: 'best_bid_ask', market: '0xr3', asset_id: '0xr3u', best_bid: '0.6', best_ask: '0.5', timestamp: String(T0 + 9) }]);
  refuse('0xr4', [okBook('0xr4', T0), { event_type: 'market_resolved', market: '0xr4', winning_outcome: 'no', timestamp: String(T0 + 9) }],
    { resolution: { outcome: 'UP', resolved_ts_ms: T0 + 9 } });
  refuse('0xr5', [okBook('0xr5', T0)], { gamma: gammaOf({ id: '0xr5', slug: 'r5', up: '0xr5u', down: '0xr5d', extra: { umaResolutionStatus: 'resolved', outcomePrices: '["0","1"]' } }) });
  refuse('0xr6', []);
  markets.push({ market_id: '0xr7', token_ids: [1, 2], labels: ['Yes', 'No'] });

  // Noise the decoder must count, not route.
  const junk = ['{not json', '[1,2', JSON.stringify({ event_type: 'book', market: '0xnobody', asset_id: 'zz', bids: [], asks: [], timestamp: String(T0) }),
    JSON.stringify({ event_type: 'tick_size_change', market: '0xm4', timestamp: String(T0 + 5) }),
    JSON.stringify({ event_type: 'last_trade_price', market: '0xm4', asset_id: 'u4', price: '0.5', size: '0', side: 'BUY', timestamp: String(T0 + 6) }),
    JSON.stringify([
      { event_type: 'last_trade_price', market: '0xm4', asset_id: 'd4', price: '0.5', size: '3', side: 'SELL', timestamp: String(T0 + 7) },
      { event_type: 'last_trade_price', market: '0xm4', asset_id: 'd4', price: 'x', size: '3', side: 'SELL', timestamp: String(T0 + 7) },
    ]), 'NaN'];

  await writeFile(path.join(dir, 'markets.json'), JSON.stringify(markets, null, 1));
  const jsonl = (rows) => `${rows.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')}\n`;
  await writeFile(path.join(dir, 'frames', 'a.jsonl'), jsonl(files.a));
  await writeFile(path.join(dir, 'frames', 'b', 'b.jsonl.gz'), gzipSync(jsonl(files.b)));
  // CRLF line ends on one file: a recorded stream is not always Unix text.
  await writeFile(path.join(dir, 'frames', 'c.jsonl'), jsonl([...files.c, ...junk]).replace(/\n/g, '\r\n'));
  // A file that is not frames at all is skipped by name, never parsed.
  await writeFile(path.join(dir, 'README.txt'), 'not a frame file\n');
  return dir;
}

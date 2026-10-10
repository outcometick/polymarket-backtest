// The pure-Python backtest (outcometick.backtest) must give the answer the
// queue and `ot run` give, from the same archive. Not "close": the same events,
// the same trades, the same fills, the same report.
//
// Three comparisons, each on two synthetic archives built to hold the awkward
// cases (fixture-archive.mjs) and — when OT_SAMPLE_DIR points at the unpacked
// public samples — on the real ones:
//
//   1. decode     runner/events.mjs + cli/local-data.mjs  vs  backtest/decode.py
//                 + backtest/local.py, market by market, event by event;
//   2. run        `ot run --json` (the Python harness, fed by Node)  vs
//                 outcometick.backtest.run_template (the same harness loop, fed
//                 in-process): every report field but wall-clock timing, and
//                 every trade and fill row;
//   3. languages  the same strategy written in JavaScript and in Python, both
//                 through `ot run`, on decoded archive data rather than the
//                 hand-built vectors runner/conformance uses.
//
// Two implementations that nobody compares drift. This repo has watched the
// local runner and the queue drift nine times.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPolymarketFixture, buildPredictFixture } from './fixture-archive.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Two homes: client/backtest/ in the monorepo, verify/ in the public
// polymarket-backtest repository — the PyPI tree at its root, and the npm
// package (`npm install outcometick@<same version>`) as the JavaScript side to
// compare against. Same test, same assertions.
const MONOREPO = existsSync(path.join(HERE, '..', '..', 'runner', 'events.mjs'));
const JS_ROOT = MONOREPO ? path.join(HERE, '..', '..') : path.join(HERE, '..', 'node_modules', 'outcometick');
const ROOT = JS_ROOT;
const PYTHON = process.env.OT_PYTHON || 'python3';
const OT = path.join(JS_ROOT, 'cli', 'ot.mjs');
const load = (rel) => import(pathToFileURL(path.join(JS_ROOT, rel)).href);
const { loadLocalDay, localDays, archiveVenues, defaultVenue } = await load('cli/local-data.mjs');
const { makeBookThrottle } = await load('runner/events.mjs');
const { readEventLines } = await load('runner/spool-day.mjs');

/**
 * The SHA-256 of each public sample tarball these comparisons were last run
 * against. The release asset is "latest", so a new sample day would otherwise
 * change what this test proves without anyone noticing; a mismatch names the
 * new digest so it can be reviewed and pinned.
 */
const SAMPLE_SHA256 = {
  'polymarket-data-samples.tar.gz': null,
  'predict-fun-data-samples.tar.gz': null,
};

/** The installed-package layout (what scripts/build-packages.mjs assembles), in a temp dir. */
async function pythonPackage(dir) {
  await mkdir(dir, { recursive: true });
  if (!MONOREPO) {
    // The public repository's root IS that layout already.
    await cp(path.join(HERE, '..', 'outcometick'), path.join(dir, 'outcometick'), { recursive: true });
    return dir;
  }
  const pkg = path.join(dir, 'outcometick');
  await mkdir(path.join(pkg, 'backtest', '_sandbox'), { recursive: true });
  await cp(path.join(ROOT, 'runner/harness/python/outcometick.py'), path.join(pkg, '__init__.py'));
  await cp(path.join(ROOT, 'client/data.py'), path.join(pkg, 'data.py'));
  for (const f of await readdir(path.join(ROOT, 'client/backtest'))) {
    if (f.endsWith('.py') || f === '_contract.json') await cp(path.join(ROOT, 'client/backtest', f), path.join(pkg, 'backtest', f));
  }
  for (const f of ['otengine.py', 'otfeed.py', 'otreplay.py', 'otharness.py']) {
    await cp(path.join(ROOT, 'runner/harness/python', f), path.join(pkg, 'backtest', '_sandbox', f));
  }
  return dir;
}

const py = (pkgDir, code, args = []) => run(PYTHON, ['-c', code, ...args], {
  // A throwaway decoded-day cache, inside the temp tree this test removes.
  env: { ...process.env, PYTHONPATH: pkgDir, XDG_CACHE_HOME: path.join(pkgDir, 'xdg') },
  maxBuffer: 512 * 1024 * 1024,
});

/** -0 survives a Python dump as "-0.0"; JSON.stringify writes it as 0. */
const noNegZero = (_k, v) => (Object.is(v, -0) ? 0 : v);

async function jsDecode(root, { datasets, intervals, assets }) {
  const venue = defaultVenue(await archiveVenues(root));
  const days = await localDays(root);
  const out = [];
  for (const day of days) {
    const eventsDir = await mkdtemp(path.join(tmpdir(), 'eq-js-'));
    try {
      const loaded = await loadLocalDay({
        root, day, venue, eventsDir, assets, datasets, intervals,
        throttle: makeBookThrottle({ venue, assets, from: days[0], to: days[days.length - 1] }),
      });
      const markets = [];
      for (const m of loaded.markets) {
        const events = (await readEventLines(path.join(eventsDir, m.eventsFile))).map((l) => JSON.parse(l));
        markets.push({ market: m.market, stream: m.stream, day: m.day, up_px: m.up_px, down_px: m.down_px, events });
      }
      out.push({ day, reason: loaded.reason ?? null, unusable: loaded.unusable ?? [], bbo_keys: loaded.bboKeys ?? [], inputs: loaded.inputs ?? [], markets });
    } finally {
      await rm(eventsDir, { recursive: true, force: true });
    }
  }
  return JSON.parse(JSON.stringify(out), noNegZero);
}

const PY_DECODE = `
import json, sys, tempfile, shutil
from outcometick.backtest.local import load_local_day, local_days, archive_venues, default_venue, read_event_lines
from outcometick.backtest.decode import BookThrottle
from otengine import Book
root, ds, iv, assets, out_path = sys.argv[1:6]
venue = default_venue(archive_venues(root)); assets = assets.split(","); days = local_days(root)
out = []
for day in days:
    d = tempfile.mkdtemp(prefix="eq-py-")
    try:
        loaded = load_local_day(root=root, day=day, venue=venue, assets=assets, datasets=ds.split(","), intervals=iv.split(","),
            throttle=BookThrottle(venue=venue, assets=assets, frm=days[0], to=days[-1]), events_dir=d, book_factory=lambda: Book(None))
        out.append({"day": day, "reason": loaded.get("reason"), "unusable": loaded.get("unusable", []),
                    "bbo_keys": loaded.get("bbo_keys", []), "inputs": loaded.get("inputs", []),
                    "markets": [{"market": m["market"], "stream": m["stream"], "day": m["day"], "up_px": m["up_px"],
                                 "down_px": m["down_px"], "events": list(read_event_lines(m["events_file"]))}
                                for m in loaded["markets"]]})
    finally:
        shutil.rmtree(d, ignore_errors=True)
json.dump(out, open(out_path, "w"))
`;

async function pyDecode(pkgDir, root, { datasets, intervals, assets }) {
  const file = path.join(pkgDir, `decode-${Date.now()}-${Math.random()}.json`);
  // The engine is registered by importing the package once.
  await py(pkgDir, `import outcometick.backtest\n${PY_DECODE}`, [root, datasets.join(','), intervals.join(','), assets.join(','), file]);
  return JSON.parse(await readFile(file, 'utf8'), noNegZero);
}

/** Every trade/fill row of an `ot run` archive, plus its report — read by Python's zipfile. */
const PY_RUN = `
import csv, io, json, sys, zipfile
from outcometick.backtest import run_template
tpl, root, report_path, zip_path, out_path = sys.argv[1:6]
r = run_template(tpl, root)
z = zipfile.ZipFile(zip_path)
def rows(name):
    return list(csv.DictReader(io.StringIO(z.read(name).decode("utf-8-sig"))))
json.dump({"report": r.report, "trades": r.trades, "fills": r.fills,
           "js": {"report": json.load(open(report_path)), "trades": rows("trades.csv"), "fills": rows("fills.csv")}},
          open(out_path, "w"))
`;

/** A CSV cell as the value toCsv wrote it from: '' was null, numbers round-trip through String(). */
function cell(want, got) {
  if (got === '') return want == null;
  if (typeof want === 'number') return Number(got) === want;
  return String(want) === got;
}

function compareRows(label, mine, theirs) {
  assert.equal(mine.length, theirs.length, `${label}: ${mine.length} rows in Python, ${theirs.length} from ot run`);
  for (let i = 0; i < theirs.length; i += 1) {
    for (const [k, v] of Object.entries(theirs[i])) {
      assert.ok(cell(mine[i][k], v), `${label} row ${i} ${k}: python ${JSON.stringify(mine[i][k])}, ot run ${JSON.stringify(v)}`);
    }
  }
}

/** The text of each entry of an archive zip (read with Python's zipfile). */
async function zipRows(zip) {
  const { stdout } = await run(PYTHON, ['-I', '-c',
    'import json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\n'
    + 'print(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))', zip], { maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function otRun(dir, root, extra = []) {
  const zip = path.join(dir, 'out.zip');
  const { stdout } = await run(process.execPath, [OT, 'run', dir, '--data', root, '--json', '--out', zip, ...extra], {
    cwd: ROOT, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, OT_PYTHON: PYTHON },
  });
  const report = JSON.parse(stdout.trim().split('\n').pop());
  return { report, zip };
}

async function writeStrategy(dir, manifest, files) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'outcometick.json'), JSON.stringify(manifest, null, 2));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  return dir;
}

// --- strategies ------------------------------------------------------------
// Each exists twice, in Python and in JavaScript, written independently: a
// generator would test the generator.

const STRATEGIES = {
  near_close: {
    manifest: { hooks: ['on_market_open', 'on_tick', 'on_settle'], datasets: ['settlement', 'book'], intervals: ['5m', '15m'] },
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.close = market.close_ts_ms
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done or self.close is None or self.close - ctx.now > 120_000:
            return None
        book = ctx.book()
        up, down = book.best("UP"), book.best("DOWN")
        if up is None or down is None:
            return None
        self.done = True
        side = "UP" if up <= down else "DOWN"
        return Order(side=side, notional=20, limit=0.95)

    def on_settle(self, ctx, market, outcome):
        ctx.log(f"settled {outcome}")
`,
    js: `import { Strategy, Order } from "outcometick";

export class S extends Strategy {
  onMarketOpen(ctx, market) { this.close = market.close_ts_ms; this.done = false; }
  onTick(ctx, tick) {
    if (this.done || this.close == null || this.close - ctx.now > 120000) return null;
    const book = ctx.book();
    const up = book.best("UP"), down = book.best("DOWN");
    if (up == null || down == null) return null;
    this.done = true;
    return new Order({ side: up <= down ? "UP" : "DOWN", notional: 20, limit: 0.95 });
  }
  onSettle(ctx, market, outcome) { ctx.log("settled " + outcome); }
}
`,
  },
  book_trade_hold: {
    manifest: { hooks: ['on_market_open', 'on_book', 'on_trade'], datasets: ['settlement', 'book', 'trades', 'bbo'], intervals: ['5m'], latency: 250 },
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_book(self, ctx, ev):
        ask = ctx.book().best("UP")
        if ask is not None and ask < 0.5 and ctx.position().size == 0 and self.n < 3:
            self.n += 1
            return Order(side="UP", size=15, limit=0.6, hold_s=30)
        return None

    def on_trade(self, ctx, trade):
        if trade.size > 25 and ctx.position().size == 0:
            return Order(side="DOWN", size=5, limit=0.9)
        return None
`,
    js: `import { Strategy, Order } from "outcometick";

export class S extends Strategy {
  onMarketOpen(ctx, market) { this.n = 0; }
  onBook(ctx, ev) {
    const ask = ctx.book().best("UP");
    if (ask != null && ask < 0.5 && ctx.position().size === 0 && this.n < 3) {
      this.n += 1;
      return new Order({ side: "UP", size: 15, limit: 0.6, hold_s: 30 });
    }
    return null;
  }
  onTrade(ctx, trade) {
    if (trade.size > 25 && ctx.position().size === 0) return new Order({ side: "DOWN", size: 5, limit: 0.9 });
    return null;
  }
}
`,
  },
  session_overlap: {
    manifest: { hooks: ['on_market_open', 'on_tick'], datasets: ['settlement', 'book'], intervals: ['5m', '15m'], mode: 'session', fee_bps: 30 },
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        if not hasattr(self, "last"):
            self.last = -1
            self.trades = 0

    def on_tick(self, ctx, tick):
        if tick.ts_ms < self.last:
            ctx.log("LOOKAHEAD")
        self.last = max(self.last, tick.ts_ms)
        if self.trades < 6 and int(tick.ts_ms / 1000) % 97 == 0:
            self.trades += 1
            return Order(side="DOWN", size=8, limit=0.9)
        return None
`,
    js: `import { Strategy, Order } from "outcometick";

export class S extends Strategy {
  onMarketOpen(ctx, market) { if (this.last === undefined) { this.last = -1; this.trades = 0; } }
  onTick(ctx, tick) {
    if (tick.ts_ms < this.last) ctx.log("LOOKAHEAD");
    this.last = Math.max(this.last, tick.ts_ms);
    if (this.trades < 6 && Math.trunc(tick.ts_ms / 1000) % 97 === 0) {
      this.trades += 1;
      return new Order({ side: "DOWN", size: 8, limit: 0.9 });
    }
    return null;
  }
}
`,
  },
};

const BASE = { schema: 1, params: {} };

async function strategyDir(root, name, lang, tag) {
  const s = STRATEGIES[name];
  const isPy = lang === 'python';
  return writeStrategy(path.join(root, `${name}-${tag}-${lang}`), {
    ...BASE,
    language: isPy ? 'python@3.14' : 'nodejs@24',
    entry: isPy ? 'strategy.py:S' : 'strategy.mjs:S',
    ...s.manifest,
  }, { [isPy ? 'strategy.py' : 'strategy.mjs']: isPy ? s.py : s.js });
}

// --- the comparisons ---------------------------------------------------------

async function archives() {
  const work = await mkdtemp(path.join(tmpdir(), 'ot-equiv-'));
  const list = [
    { name: 'polymarket fixture', root: await buildPolymarketFixture(path.join(work, 'pm')), assets: ['BTC', 'ETH', 'SOL', 'XRP'] },
    { name: 'predict fixture', root: await buildPredictFixture(path.join(work, 'pf')), assets: ['BTC', 'ETH', 'SOL', 'XRP'] },
  ];
  const samples = process.env.OT_SAMPLE_DIR;
  if (samples) {
    for (const [tarball, dirName, label] of [
      ['polymarket-data-samples.tar.gz', 'polymarket-data-samples', 'polymarket sample'],
      ['predict-fun-data-samples.tar.gz', 'predict-fun-data-samples', 'predict sample'],
    ]) {
      const tgz = path.join(samples, tarball);
      const sha = createHash('sha256').update(await readFile(tgz)).digest('hex');
      if (SAMPLE_SHA256[tarball] && SAMPLE_SHA256[tarball] !== sha) {
        throw new Error(`${tarball} is ${sha}, not the pinned ${SAMPLE_SHA256[tarball]} — a new sample; review and pin it`);
      }
      list.push({ name: `${label} ${sha.slice(0, 12)}`, root: path.join(samples, dirName), assets: ['BTC', 'ETH', 'SOL', 'XRP'] });
    }
  }
  return { work, list };
}

test('the Python decoder produces the same events as the JS decoder', { timeout: 30 * 60_000 }, async () => {
  const { work, list } = await archives();
  const pkg = await pythonPackage(path.join(work, 'pkg'));
  try {
    for (const a of list) {
      for (const shape of [
        { datasets: ['settlement', 'book', 'trades', 'bbo'], intervals: ['5m', '15m'] },
        { datasets: ['settlement'], intervals: ['5m'] },
      ]) {
        const opts = { ...shape, assets: a.assets };
        const [js, pyOut] = await Promise.all([jsDecode(a.root, opts), pyDecode(pkg, a.root, opts)]);
        const events = js.reduce((n, d) => n + d.markets.reduce((k, m) => k + m.events.length, 0), 0);
        // Vacuity guard: an archive that decodes to nothing would agree trivially.
        assert.ok(events > 0, `${a.name}: nothing decoded`);
        assert.deepStrictEqual(pyOut, js, `${a.name} ${JSON.stringify(shape)}: decoders disagree`);
        // The synthetic Polymarket archive carries a market with an unusable
        // token pair (fixture-archive.mjs, 'btc-updown-5m-f'): agreement only
        // proves something if both decoders actually reached that verdict.
        if (a.name === 'polymarket fixture' && shape.datasets.includes('book')) {
          const why = js.flatMap((d) => d.unusable.map((u) => u.why));
          assert.ok(why.includes('market has no usable [Up, Down] token ids'), `token-pair case not exercised: ${JSON.stringify(why)}`);
        }
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('outcometick.backtest reproduces `ot run`: every report field, trade and fill', { timeout: 60 * 60_000 }, async () => {
  const { work, list } = await archives();
  const pkg = await pythonPackage(path.join(work, 'pkg'));
  try {
    for (const a of list) {
      for (const name of Object.keys(STRATEGIES)) {
        const dir = await strategyDir(work, name, 'python', a.name.replace(/\W+/g, '_'));
        const { report, zip } = await otRun(dir, a.root);
        await writeFile(path.join(dir, 'report.json'), JSON.stringify(report));
        const outPath = path.join(dir, 'py.json');
        await py(pkg, PY_RUN, [dir, a.root, path.join(dir, 'report.json'), zip, outPath]);
        const got = JSON.parse(await readFile(outPath, 'utf8'), noNegZero);
        const label = `${a.name} / ${name}`;
        const { budget: _a, ...mine } = got.report;
        const { budget: _b, ...theirs } = got.js.report;
        assert.deepStrictEqual(mine, theirs, `${label}: reports differ`);
        compareRows(`${label} trades`, got.trades, got.js.trades);
        compareRows(`${label} fills`, got.fills, got.js.fills);
        assert.ok(!/LOOKAHEAD/.test(JSON.stringify(got.report)), `${label}: look-ahead`);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the same strategy in JavaScript and in Python trades identically on archive data', { timeout: 60 * 60_000 }, async () => {
  const { work, list } = await archives();
  try {
    for (const a of list) {
      for (const name of Object.keys(STRATEGIES)) {
        const tag = a.name.replace(/\W+/g, '_');
        const pyDir = await strategyDir(work, name, 'python', tag);
        const jsDir = await strategyDir(work, name, 'nodejs', tag);
        const [p, j] = await Promise.all([otRun(pyDir, a.root), otRun(jsDir, a.root)]);
        const label = `${a.name} / ${name}`;
        // Everything a strategy's language must not change.
        for (const k of ['metrics', 'equity', 'trades_head', 'rows', 'calibration', 'baselines', 'split', 'slippage', 'fee_model', 'coverage', 'scanned']) {
          assert.deepStrictEqual(p.report[k], j.report[k], `${label}: ${k} differs between languages`);
        }
        assert.ok(p.report.rows.trades > 0, `${label}: the strategy never traded, so this proves nothing`);
        // Every row, byte for byte: both archives are written by the same CSV
        // writer from what each harness sent, so any difference is the engine.
        const [pRows, jRows] = await Promise.all([zipRows(p.zip), zipRows(j.zip)]);
        assert.equal(pRows['trades.csv'], jRows['trades.csv'], `${label}: trades differ between languages`);
        assert.equal(pRows['fills.csv'], jRows['fills.csv'], `${label}: fills differ between languages`);
        assert.equal(pRows['logs.txt'], jRows['logs.txt'], `${label}: logs differ between languages`);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

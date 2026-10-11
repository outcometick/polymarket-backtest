// Generic data: the JavaScript decoder (runner/generic-data.mjs) and the
// Python port (backtest/generic.py) must produce the same markets and the same
// events from the same dataset, and every way in must produce the same run:
//
//   1. decode     decodeGenericDir vs decode_generic_dir: records, terminal
//                 marks, refusals with reasons, row counts, every event;
//   2. run        `ot run --json` (Python harness) vs run_template (in-process)
//                 vs `ot run` of the same strategy written in JavaScript:
//                 every trade, every fill, the report.
//
// On generic-fixture.mjs, which holds the awkward cases on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGenericFixture } from './generic-fixture.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO = existsSync(path.join(HERE, '..', '..', 'runner', 'events.mjs'));
const JS_ROOT = MONOREPO ? path.join(HERE, '..', '..') : path.join(HERE, '..', 'node_modules', 'outcometick');
const PYTHON = process.env.OT_PYTHON || 'python3';
const OT = path.join(JS_ROOT, 'cli', 'ot.mjs');
const { decodeGenericDir } = await import(pathToFileURL(path.join(JS_ROOT, 'runner', 'generic-data.mjs')).href);

async function pythonPackage(dir) {
  await mkdir(dir, { recursive: true });
  if (!MONOREPO) {
    await cp(path.join(HERE, '..', 'outcometick'), path.join(dir, 'outcometick'), { recursive: true });
    return dir;
  }
  const pkg = path.join(dir, 'outcometick');
  await mkdir(path.join(pkg, 'backtest', '_sandbox'), { recursive: true });
  await cp(path.join(JS_ROOT, 'runner/harness/python/outcometick.py'), path.join(pkg, '__init__.py'));
  await cp(path.join(JS_ROOT, 'client/data.py'), path.join(pkg, 'data.py'));
  for (const f of await readdir(path.join(JS_ROOT, 'client/backtest'))) {
    if (f.endsWith('.py') || f === '_contract.json') await cp(path.join(JS_ROOT, 'client/backtest', f), path.join(pkg, 'backtest', f));
  }
  for (const f of ['otengine.py', 'otfeed.py', 'otmaker.py', 'otreplay.py', 'otharness.py']) {
    await cp(path.join(JS_ROOT, 'runner/harness/python', f), path.join(pkg, 'backtest', '_sandbox', f));
  }
  return dir;
}

const py = (pkgDir, code, args = []) => run(PYTHON, ['-c', code, ...args], {
  env: { ...process.env, PYTHONPATH: pkgDir, PYTHONDONTWRITEBYTECODE: '1' },
  maxBuffer: 512 * 1024 * 1024,
});
const noNegZero = (_k, v) => (Object.is(v, -0) ? 0 : v);

async function jsDecode(root) {
  const dir = await mkdtemp(path.join(tmpdir(), 'geq-js-'));
  try {
    const out = await decodeGenericDir(root, { eventsDir: dir });
    for (const m of out.markets) {
      const text = await readFile(path.join(dir, m.eventsFile), 'utf8');
      m.events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      delete m.eventsFile;
    }
    return JSON.parse(JSON.stringify(out), noNegZero);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PY_DECODE = `
import json, sys, tempfile, shutil
import outcometick.backtest
from outcometick.backtest.generic import decode_generic_dir
from otengine import Book
root, out_path = sys.argv[1:3]
d = tempfile.mkdtemp(prefix="geq-py-")
try:
    out = decode_generic_dir(root, events_dir=d, book_factory=lambda: Book(None))
    for m in out["markets"]:
        with open(m["events_file"], encoding="utf-8") as fh:
            m["events"] = [json.loads(l) for l in fh if l.strip()]
        del m["events_file"], m["eventsFile"]
finally:
    shutil.rmtree(d, ignore_errors=True)
json.dump(out, open(out_path, "w"))
`;

async function pyDecode(pkgDir, root) {
  const file = path.join(pkgDir, `gdecode-${Date.now()}.json`);
  await py(pkgDir, PY_DECODE, [root, file]);
  return JSON.parse(await readFile(file, 'utf8'), noNegZero);
}

// --- strategies, each written once per language --------------------------------

const STRATEGIES = {
  label_taker: {
    manifest: { hooks: ['on_market_open', 'on_book', 'on_trade', 'on_settle'], datasets: ['book', 'trades'], latency: 120 },
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.labels = list(market.labels)
        self.n = 0

    def on_book(self, ctx, ev):
        book = ctx.book()
        a, b = book.best("UP"), book.best("DOWN")
        if a is None or b is None or self.n >= 4 or ctx.position().size > 0:
            return None
        self.n += 1
        # Orders named by LABEL, the generic-data way.
        side = self.labels[0] if a <= b else self.labels[1]
        return Order(side=side, size=12, limit=0.8, hold_s=20 if self.n % 2 else None)

    def on_trade(self, ctx, trade):
        if trade.size > 50 and ctx.position().size > 0:
            p = ctx.position()
            return Order(side=p.side, size=p.size, limit=0.01, reduce_only=True)
        return None

    def on_settle(self, ctx, market, outcome):
        ctx.log(f"settled {outcome} {market.resolved_ts_ms}")
`,
    js: `import { Strategy, Order } from "outcometick";

export class S extends Strategy {
  onMarketOpen(ctx, market) { this.labels = [...market.labels]; this.n = 0; }
  onBook(ctx, ev) {
    const book = ctx.book();
    const a = book.best("UP"), b = book.best("DOWN");
    if (a == null || b == null || this.n >= 4 || ctx.position().size > 0) return null;
    this.n += 1;
    const side = a <= b ? this.labels[0] : this.labels[1];
    return new Order({ side, size: 12, limit: 0.8, hold_s: this.n % 2 ? 20 : null });
  }
  onTrade(ctx, trade) {
    if (trade.size > 50 && ctx.position().size > 0) {
      const p = ctx.position();
      return new Order({ side: p.side, size: p.size, limit: 0.01, reduce_only: true });
    }
    return null;
  }
  onSettle(ctx, market, outcome) { ctx.log("settled " + outcome + " " + market.resolved_ts_ms); }
}
`,
  },
  maker: {
    manifest: { hooks: ['on_market_open', 'on_book'], datasets: ['book', 'trades'], latency: 80, cancel_latency: 30 },
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.last = None

    def on_book(self, ctx, ev):
        if self.last is not None and ctx.now - self.last < 5000:
            return None
        self.last = ctx.now
        for o in ctx.orders():
            ctx.cancel(o.id)
        bid = ctx.book().best_bid("UP")
        if bid is None or bid < 0.05 or bid > 0.95:
            return None
        if ctx.position().size >= 60:
            return Order(side="UP", size=20, limit=round(bid + 0.02, 2), tif="gtc", reduce_only=True)
        return Order(side="UP", size=20, limit=round(bid, 2), tif="gtc")
`,
    js: `import { Strategy, Order } from "outcometick";

export class S extends Strategy {
  onMarketOpen(ctx, market) { this.last = null; }
  onBook(ctx, ev) {
    if (this.last != null && ctx.now - this.last < 5000) return null;
    this.last = ctx.now;
    for (const o of ctx.orders()) ctx.cancel(o.id);
    const bid = ctx.book().bestBid("UP");
    if (bid == null || bid < 0.05 || bid > 0.95) return null;
    if (ctx.position().size >= 60) return new Order({ side: "UP", size: 20, limit: Math.round((bid + 0.02) * 100) / 100, tif: "gtc", reduce_only: true });
    return new Order({ side: "UP", size: 20, limit: Math.round(bid * 100) / 100, tif: "gtc" });
  }
}
`,
  },
};
// Session: one instance across overlapping markets, so state is per market.
STRATEGIES.session = {
  manifest: { hooks: ['on_book', 'on_settle'], datasets: ['book', 'trades'], mode: 'session', latency: 60 },
  py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_book(self, ctx, ev):
        if not hasattr(self, "n"):
            self.n = {}
        book = ctx.book()
        k = book.market_id
        a, b = book.best("UP"), book.best("DOWN")
        if a is None or b is None or self.n.get(k, 0) >= 3 or ctx.position().size > 0:
            return None
        self.n[k] = self.n.get(k, 0) + 1
        return Order(side="UP" if a <= b else "DOWN", size=7, limit=0.7, hold_s=15)

    def on_settle(self, ctx, market, outcome):
        ctx.log(f"settled {market.market_id} {outcome}")
`,
  js: `import { Strategy, Order } from "outcometick";

export class S extends Strategy {
  onBook(ctx, ev) {
    if (this.n === undefined) this.n = {};
    const book = ctx.book();
    const k = book.marketId ?? book.market_id;
    const a = book.best("UP"), b = book.best("DOWN");
    if (a == null || b == null || (this.n[k] ?? 0) >= 3 || ctx.position().size > 0) return null;
    this.n[k] = (this.n[k] ?? 0) + 1;
    return new Order({ side: a <= b ? "UP" : "DOWN", size: 7, limit: 0.7, hold_s: 15 });
  }
  onSettle(ctx, market, outcome) { ctx.log("settled " + market.market_id + " " + outcome); }
}
`,
};

async function writeStrategy(dir, manifest, lang, source) {
  await mkdir(dir, { recursive: true });
  const file = lang === 'python' ? 'strategy.py' : 'strategy.mjs';
  await writeFile(path.join(dir, 'outcometick.json'), JSON.stringify({
    schema: 1, language: lang === 'python' ? 'python@3.14' : 'nodejs@24', entry: `${file}:S`, params: {}, ...manifest,
  }, null, 2));
  await writeFile(path.join(dir, file), source);
  return dir;
}

async function otRun(dir, root) {
  const zip = path.join(dir, 'out.zip');
  const { stdout } = await run(process.execPath, [OT, 'run', dir, '--data', root, '--json', '--out', zip], {
    cwd: JS_ROOT, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, OT_PYTHON: PYTHON, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { report: JSON.parse(stdout.trim().split('\n').pop()), zip };
}

/** trades.csv / fills.csv / report.json of an `ot run` archive, as Python reads them. */
const PY_RUN = `
import csv, io, json, sys, zipfile
from outcometick.backtest import run_template
tpl, root, zip_js, zip_py, out_path = sys.argv[1:6]
r = run_template(tpl, root)
def rows(z, name):
    return list(csv.DictReader(io.StringIO(zipfile.ZipFile(z).read(name).decode("utf-8-sig"))))
def report(z):
    return json.loads(zipfile.ZipFile(z).read("report.json").decode("utf-8"))
json.dump({"lib": {"report": r.report, "trades": r.trades, "fills": r.fills},
           "js": {"report": report(zip_js), "trades": rows(zip_js, "trades.csv"), "fills": rows(zip_js, "fills.csv")},
           "py": {"report": report(zip_py), "trades": rows(zip_py, "trades.csv"), "fills": rows(zip_py, "fills.csv")}},
          open(out_path, "w"))
`;

function cell(want, got) {
  // CSV against CSV: the same text.
  if (typeof want === 'string' && typeof got === 'string') return want === got;
  if (got === '') return want == null;
  if (typeof want === 'number') return Number(got) === want;
  return String(want) === got;
}

function sameRows(label, mine, theirs) {
  assert.equal(mine.length, theirs.length, `${label}: ${mine.length} vs ${theirs.length} rows`);
  for (let i = 0; i < theirs.length; i += 1) {
    for (const [k, v] of Object.entries(theirs[i])) {
      assert.ok(cell(mine[i][k], v), `${label} row ${i} ${k}: ${JSON.stringify(mine[i][k])} vs ${JSON.stringify(v)}`);
    }
  }
}

const VOLATILE = ['generated_ms', 'run_id', 'budget'];
function stable(report) {
  const r = JSON.parse(JSON.stringify(report), noNegZero);
  for (const k of VOLATILE) delete r[k];
  if (r.coverage) delete r.coverage.source;
  return r;
}

let work;
let pkg;
let root;

test.before(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'geq-'));
  pkg = await pythonPackage(path.join(work, 'pkg'));
  root = await buildGenericFixture(path.join(work, 'data'));
});
test.after(async () => { await rm(work, { recursive: true, force: true }); });

test('generic decode: JavaScript and Python agree on every market, refusal, count and event', async () => {
  const js = await jsDecode(root);
  const pyOut = await pyDecode(pkg, root);
  assert.deepEqual(pyOut.unusable, js.unusable);
  assert.deepEqual(pyOut.counts, js.counts);
  assert.deepEqual(pyOut.inputs, js.inputs);
  assert.equal(pyOut.markets.length, js.markets.length);
  for (let i = 0; i < js.markets.length; i += 1) {
    const a = js.markets[i];
    const b = pyOut.markets[i];
    assert.deepEqual({ ...b, events: undefined }, { ...a, events: undefined }, `market ${a.market.market_id}`);
    assert.equal(b.events.length, a.events.length, `${a.market.market_id} event count`);
    for (let j = 0; j < a.events.length; j += 1) assert.deepEqual(b.events[j], a.events[j], `${a.market.market_id} event ${j}`);
  }
  // The fixture exercises what it claims to.
  const ids = js.markets.map((m) => m.market.market_id);
  assert.deepEqual(ids, ['0xm1', '0xm2', '0xm3', '0xm4', '0xm5']);
  assert.deepEqual(js.unusable.map((u) => u.market_id), ['0xr7', '0xr1', '0xr2', '0xr3', '0xr4', '0xr5', '0xr6']);
  const by = Object.fromEntries(js.markets.map((m) => [m.market.market_id, m]));
  assert.equal(by['0xm1'].market.resolution_source, 'gamma');
  assert.equal(by['0xm2'].market.outcome, 'DOWN');
  assert.equal(by['0xm3'].market.outcome, 'TIE');
  assert.equal(by['0xm3'].events[0].synthetic, true);
  assert.ok(by['0xm4'].terminal.source, 'marked');
  assert.notEqual(by['0xm5'].terminal.source, 'up_mid');
  assert.ok(js.counts.after_trading_end > 0);
  assert.ok(js.counts.bad_json >= 3);
});

for (const [name, s] of Object.entries(STRATEGIES)) {
  test(`generic run "${name}": ot run (JS), ot run (Python) and the Python library agree`, async () => {
    const dir = path.join(work, `run-${name}`);
    const jsDir = await writeStrategy(path.join(dir, 'js'), s.manifest, 'nodejs', s.js);
    const pyDir = await writeStrategy(path.join(dir, 'py'), s.manifest, 'python', s.py);
    const js = await otRun(jsDir, root);
    const pyr = await otRun(pyDir, root);
    const file = path.join(dir, 'cmp.json');
    await py(pkg, PY_RUN, [pyDir, root, js.zip, pyr.zip, file]);
    const got = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(got.js.trades.length > 0, 'the strategy traded');
    sameRows('trades js vs py', got.py.trades, got.js.trades);
    sameRows('fills js vs py', got.py.fills, got.js.fills);
    sameRows('trades lib vs ot run', got.lib.trades, got.py.trades);
    sameRows('fills lib vs ot run', got.lib.fills, got.py.fills);
    const rep = stable(got.py.report);
    assert.deepEqual(stable(got.lib.report), rep);
    const jsRep = stable(got.js.report);
    // Two strategies in two languages: different code, so a different
    // fingerprint by design. lib vs ot run above is the same directory.
    assert.ok(rep.fingerprint?.sha256, 'a generic run carries a fingerprint');
    for (const k of ['language', 'fingerprint']) { delete jsRep[k]; delete rep[k]; }
    assert.deepEqual(jsRep, rep);
    assert.equal(rep.data_kind, 'generic');
    assert.ok(got.js.trades.some((t) => t.label), 'rows carry labels');
    const logs = async (zip) => (await run(PYTHON, ['-I', '-c', 'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read("logs.txt").decode())', zip])).stdout;
    assert.equal(await logs(pyr.zip), await logs(js.zip), 'logs, line for line');
  });
}

// The JavaScript value rules the Python port reproduces (client/backtest/_js.py),
// checked against JavaScript itself rather than against a hand-written table.
//
// These are the cases real data almost never hits and the equivalence suite
// therefore cannot prove: a tie exactly on .5 in toFixed, a hex string in a
// numeric field, an empty CSV cell, a number past 1e21. Each one is a place
// where Python's nearest built-in gives a different answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// client/backtest/ in the monorepo; verify/ in the public Python repository,
// with the npm package installed beside it as the JavaScript side.
const MONOREPO = existsSync(path.join(HERE, '..', '..', 'runner', 'events.mjs'));
const JS_ROOT = MONOREPO ? path.join(HERE, '..', '..') : path.join(HERE, '..', 'node_modules', 'outcometick');
const { num } = await import(pathToFileURL(path.join(JS_ROOT, 'runner', 'events.mjs')).href);
// The Python side: the source package in the monorepo, the repository root outside it.
const PY_PATH = MONOREPO ? path.join(HERE, '..') : path.join(HERE, '..');
const PY_MODULE = MONOREPO ? 'backtest._js' : 'outcometick.backtest._js';
const PYTHON = process.env.OT_PYTHON || 'python3';

const NUM_INPUTS = [
  '', ' ', ' 12 ', '12', '-3.5', '0x10', '0X1f', '0b11', '0o7', '-0x10', '0x', '1e3', '1E-2', '.5', '5.', '+5',
  '1_0', 'Infinity', '-Infinity', '+Infinity', 'NaN', 'nan', 'inf', ' 12 ', '﻿7', '\u0085 3', '　 8',
  '١٢', '1e400', '0.1', '-0', 'abc', '12abc', [], [5], ['7'], [1, 2], [[]], true, false, null, {}, 0, -0, 1.5, 2 ** 60,
];
const STRING_INPUTS = [
  0, -0, 1, 1.5, -2.25, 1e21, 1e-7, 123456789012345680000, 0.000001, 0.0000001, 1.7976931348623157e308, 5e-324,
  100, 0.1 + 0.2, 1e16, 12345678901234567, 2 ** 53, -1e-7, 999999999999999900000,
];
const FIXED_INPUTS = [
  [0.125, 2], [0.375, 2], [1.005, 2], [-0.125, 2], [-0.001, 2], [2.5, 0], [-2.5, 0], [1e21, 2], [0.5, 0], [1.45, 1],
  [8.345, 2], [1234.5678, 2], [0.000049999, 4], [-0, 2], [1 - 0.4, 10], [1 - 0.41, 10], [0.99999, 4], [123.456, 4],
];

const PY = `
import json, sys
from __MODULE__ import num, js_string, js_to_fixed, js_math_round
spec = json.loads(sys.stdin.read())
out = {
    "num": [num(v) for v in spec["num"]],
    "string": [js_string(v) for v in spec["string"]],
    "fixed": [js_to_fixed(x, d) for x, d in spec["fixed"]],
    "round": [js_math_round(x) for x in spec["round"]],
}
print(json.dumps(out))
`;

const ROUND_INPUTS = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, 4503599627370497, -4503599627370497, 1.4999999999999998];

test('the Python port reads, prints and rounds numbers exactly as JavaScript does', async () => {
  // JSON cannot carry -0 or 1e400, so those are sent as the strings JS would
  // receive from a CSV cell; the numeric -0 is covered by STRING_INPUTS' own
  // handling below.
  const spec = {
    num: NUM_INPUTS.map((v) => (Object.is(v, -0) ? 0 : v)),
    string: STRING_INPUTS.map((v) => (Object.is(v, -0) ? 0 : v)),
    fixed: FIXED_INPUTS.map(([x, d]) => [Object.is(x, -0) ? 0 : x, d]),
    round: ROUND_INPUTS,
  };
  const child = run(PYTHON, ['-c', PY.replace('__MODULE__', PY_MODULE)], { env: { ...process.env, PYTHONPATH: PY_PATH } });
  child.child.stdin.end(JSON.stringify(spec));
  const { stdout } = await child;
  const got = JSON.parse(stdout);

  spec.num.forEach((v, i) => {
    assert.deepStrictEqual(got.num[i] ?? null, num(v), `num(${JSON.stringify(v)})`);
  });
  spec.string.forEach((v, i) => assert.equal(got.string[i], String(v), `String(${v})`));
  spec.fixed.forEach(([x, d], i) => assert.equal(got.fixed[i], x.toFixed(d), `(${x}).toFixed(${d})`));
  // === rather than Object.is: Math.round(-0.5) is -0, which JSON cannot carry.
  spec.round.forEach((x, i) => assert.ok(got.round[i] === Math.round(x), `Math.round(${x}): python ${got.round[i]}`));
});

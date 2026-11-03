// Run with:  npm test   (or: node --test)
import test from "node:test";
import assert from "node:assert/strict";
import { largestRemainder, computeSplit, balances, settleUp, parseMoney, fmt, involved } from "../js/math.js";

const sum = a => a.reduce((x, y) => x + y, 0);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

test("parseMoney reads typed amounts into minor units", () => {
  assert.equal(parseMoney("1,250.50"), 125050);
  assert.equal(parseMoney(" 99 "), 9900);
  assert.equal(parseMoney("0.07"), 7);
  assert.ok(Number.isNaN(parseMoney("")));
  assert.ok(Number.isNaN(parseMoney("abc")));
});

test("fmt formats with the group's currency", () => {
  assert.equal(fmt(125050, "₹"), "₹1,250.50");
  assert.equal(fmt(-5, "$"), "-$0.05");
});

test("largestRemainder: parts always add up exactly", () => {
  assert.deepEqual(largestRemainder(100000, [1, 1, 1]), [33334, 33333, 33333]);
  for (let i = 0; i < 3000; i++){
    const n = rnd(1, 12), total = rnd(1, 5_000_000), w = Array.from({ length: n }, () => rnd(1, 20));
    const out = largestRemainder(total, w);
    assert.equal(sum(out), total);
    assert.ok(out.every(x => Number.isInteger(x) && x >= 0));
  }
});

test("equal split", () => {
  const r = computeSplit(10000, "equal", [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 1 }]);
  assert.equal(sum(Object.values(r.shares)), 10000);
});

test("percent split must total 100", () => {
  const ok = computeSplit(10000, "percent", [{ id: "a", v: 50 }, { id: "b", v: 30 }, { id: "c", v: 20 }]);
  assert.deepEqual(ok.shares, { a: 5000, b: 3000, c: 2000 });
  const bad = computeSplit(10000, "percent", [{ id: "a", v: 50 }, { id: "b", v: 30 }]);
  assert.match(bad.error, /add up to 80%/);
  const odd = computeSplit(10000, "percent", [{ id: "a", v: 33.33 }, { id: "b", v: 33.33 }, { id: "c", v: 33.34 }]);
  assert.equal(sum(Object.values(odd.shares)), 10000);
});

test("shares split", () => {
  const r = computeSplit(10000, "shares", [{ id: "a", v: 2 }, { id: "b", v: 1 }]);
  assert.deepEqual(r.shares, { a: 6667, b: 3333 });
  assert.match(computeSplit(100, "shares", [{ id: "a", v: 0 }]).error, /at least one person a share/);
});

test("exact split must match the amount", () => {
  assert.equal(computeSplit(10000, "exact", [{ id: "a", v: 6000 }, { id: "b", v: 4000 }]).error, undefined);
  const r = computeSplit(10000, "exact", [{ id: "a", v: 6000 }, { id: "b", v: 3000 }], "₹");
  assert.match(r.error, /₹10\.00 left/);
  assert.match(computeSplit(10000, "exact", [{ id: "a", v: 7000 }, { id: "b", v: 4000 }], "₹").error, /₹10\.00 over/);
});

test("no people or no amount", () => {
  assert.match(computeSplit(100, "equal", []).error, /at least one person/);
  assert.equal(computeSplit(0, "equal", [{ id: "a", v: 1 }]).pending, true);
});

function randomGroup(){
  const n = rnd(2, 8), members = Array.from({ length: n }, (_, i) => ({ id: "m" + i }));
  const expenses = Array.from({ length: rnd(0, 25) }, () => {
    const amount = rnd(1, 2_000_000), who = members.filter(() => Math.random() < 0.6);
    const parts = (who.length ? who : [members[0]]).map(m => ({ id: m.id, v: rnd(1, 5) }));
    const r = computeSplit(amount, "shares", parts);
    return { payer: members[rnd(0, n - 1)].id, amount, shares: r.shares };
  });
  const payments = Array.from({ length: rnd(0, 6) }, () => {
    const f = rnd(0, n - 1); let t = rnd(0, n - 1); if (t === f) t = (t + 1) % n;
    return { from: members[f].id, to: members[t].id, amount: rnd(1, 50000) };
  });
  return { members, expenses, payments };
}

test("balances always add up to zero", () => {
  for (let i = 0; i < 1000; i++){
    const b = balances(randomGroup());
    assert.equal(sum(Object.values(b.net)), 0);
  }
});

test("settleUp clears every balance with at most n-1 payments", () => {
  for (let i = 0; i < 1000; i++){
    const G = randomGroup(), b = balances(G), plan = settleUp(b.net);
    const after = { ...b.net };
    for (const p of plan){ after[p.from] += p.amount; after[p.to] -= p.amount; assert.ok(p.amount > 0); }
    assert.ok(Object.values(after).every(v => v === 0));
    assert.ok(plan.length <= Math.max(0, G.members.length - 1));
  }
});

test("recording a suggested payment settles the group", () => {
  const G = { members: [{ id: "a" }, { id: "b" }], expenses: [{ payer: "a", amount: 1000, shares: { a: 500, b: 500 } }], payments: [] };
  const plan = settleUp(balances(G).net);
  assert.deepEqual(plan, [{ from: "b", to: "a", amount: 500 }]);
  G.payments.push({ from: "b", to: "a", amount: 500 });
  assert.deepEqual(settleUp(balances(G).net), []);
});

test("involved tells who cannot be removed", () => {
  const G = { members: [{ id: "a" }, { id: "b" }, { id: "c" }], expenses: [{ payer: "a", amount: 10, shares: { a: 5, b: 5 } }], payments: [] };
  assert.equal(involved(G, "a"), true);
  assert.equal(involved(G, "b"), true);
  assert.equal(involved(G, "c"), false);
});

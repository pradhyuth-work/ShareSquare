// Run with:  npm test   (or: node --test)
import test from "node:test";
import assert from "node:assert/strict";
import { parseReceipt, splitBill } from "../js/bill.js";

const sum = a => a.reduce((x, y) => x + y, 0);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

const INDIAN = `THE BEACH SHACK
Candolim, Goa
Ph: 0832 2456789
GSTIN: 30ABCDE1234F1Z5
Date: 12/11/2026   Time: 20:14
Bill No: 4521   Table: 7
Item             Qty   Rate    Amount
Butter Naan        4   45.00   180.00
Paneer Tikka       1  320.00   320.00
2 x Fish Curry Rice  240.00   480.00
Sub Total                      980.00
Discount                       -50.00
CGST @2.5%                      23.25
SGST @2.5%                      23.25
Service Charge 5%               46.50
Round Off                        0.00
Grand Total                   1023.00
Paid by UPI                   1023.00
Thank you, visit again`;

test("parseReceipt reads an Indian restaurant bill", () => {
  const r = parseReceipt(INDIAN);
  assert.equal(r.merchant, "THE BEACH SHACK");
  assert.equal(r.date, "2026-11-12");
  assert.deepEqual(r.items, [
    { name: "Butter Naan ×4", amount: 18000 },
    { name: "Paneer Tikka", amount: 32000 },
    { name: "Fish Curry Rice ×2", amount: 48000 }
  ]);
  assert.equal(r.subtotal, 98000);
  assert.equal(r.discount, 5000);
  assert.equal(r.tax, 4650);
  assert.equal(r.service, 4650);
  assert.equal(r.total, 102300);
  // what we read adds back up to the printed total
  assert.equal(sum(r.items.map(i => i.amount)) + r.tax + r.service - r.discount + r.round, r.total);
});

test("parseReceipt reads a western receipt with a tip and ignores the card line", () => {
  const r = parseReceipt(`Joe's Diner
123 Main St
08/11/2026 7:32 PM
2 Burger          25.98
1 Fries            4.50
Subtotal          30.48
Tax                2.44
Tip                6.00
Total             38.92
VISA ****1234     38.92`);
  assert.equal(r.merchant, "Joe's Diner");
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].amount, 2598);
  assert.equal(r.tax, 244);
  assert.equal(r.service, 600);
  assert.equal(r.total, 3892);
});

test("parseReceipt uses a printed GST total instead of adding CGST and SGST again", () => {
  const r = parseReceipt("Dosa 100.00\nCGST 2.50\nSGST 2.50\nTotal GST 5.00\nTotal 105.00");
  assert.equal(r.tax, 500);
  assert.equal(r.items.length, 1);
});

test("parseReceipt reads comma decimals, thousands, and negative rounding", () => {
  const r = parseReceipt("Thali 1,250,00\nLassi 90,00\nRound off -0,10\nTotal 1339,90");
  assert.deepEqual(r.items.map(i => i.amount), [125000, 9000]);
  assert.equal(r.round, -10);
  assert.equal(r.total, 133990);
});

test("parseReceipt gives back something safe for junk and empty input", () => {
  for (const t of ["", null, undefined, "   \n\n", "hello world\nno prices here"]){
    const r = parseReceipt(t);
    assert.deepEqual(r.items, []);
    assert.equal(r.total, 0);
  }
  assert.equal(parseReceipt("Tea 20.00\nDate 31/02/2026").date, null);
  assert.equal(parseReceipt("Tea 20.00\nDate 01/01/2090").date, null);
});

test("splitBill: shared items split equally, extras follow what each person ordered", () => {
  // Pizza 600 shared by A, B, C. Beer 300 only A. Tax 90.
  const r = splitBill({ items: [
    { name: "Pizza", amount: 60000, who: ["a", "b", "c"] },
    { name: "Beer", amount: 30000, who: ["a"] }
  ], tax: 9000 }, ["a", "b", "c"]);
  assert.equal(r.subtotal, 90000);
  assert.equal(r.total, 99000);
  // A ordered 500 of 900 -> +50 tax; B and C ordered 200 each -> +20 tax each
  assert.deepEqual(r.shares, { a: 55000, b: 22000, c: 22000 });
});

test("splitBill: discount and round-off reduce the bill, a tip increases it", () => {
  const r = splitBill({ items: [{ name: "x", amount: 10000, who: ["a", "b"] }], discount: 1000, round: -10, service: 500 }, ["a", "b"]);
  assert.equal(r.total, 10000 - 1000 - 10 + 500);
  assert.equal(sum(Object.values(r.shares)), r.total);
});

test("splitBill: shares always add up to the total, never go negative", () => {
  for (let i = 0; i < 3000; i++){
    const people = Array.from({ length: rnd(1, 7) }, (_, k) => "p" + k);
    const items = Array.from({ length: rnd(1, 9) }, () => {
      const who = people.filter(() => Math.random() < 0.6);
      return { name: "i", amount: rnd(1, 300000), who: who.length ? who : [people[rnd(0, people.length - 1)]] };
    });
    const subtotal = sum(items.map(i => i.amount));
    const r = splitBill({ items, tax: rnd(0, 50000), service: rnd(0, 20000), discount: rnd(0, subtotal - 1), round: rnd(-99, 99) }, people);
    if (r.error) continue;
    assert.equal(sum(Object.values(r.shares)), r.total);
    assert.ok(Object.values(r.shares).every(v => Number.isInteger(v) && v >= 0));
  }
});

test("splitBill: says what is wrong instead of guessing", () => {
  assert.match(splitBill({ items: [] }, ["a"]).error, /at least one item/);
  assert.match(splitBill({ items: [{ name: "Soup", amount: 100, who: [] }] }, ["a"]).error, /Soup/);
  assert.match(splitBill({ items: [{ name: "x", amount: 100, who: ["a"] }], discount: 500 }, ["a"]).error, /discount/);
});

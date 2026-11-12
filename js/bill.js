// Reading a scanned bill and splitting it item by item. No browser or network code here, so it is easy to test.
// All amounts are whole minor units (paise/cents).
import { largestRemainder, parseMoney } from "./math.js";

const MONEY = /(?<![\d.,])-?\d[\d,]*\.\d{2}(?!\d)/g;

const RE = {
  saved: /you\s*sav|total\s*sav/i,
  subtotal: /sub\s*-?\s*total|item\s*total|total\s*before/i,
  taxTotal: /total\s*(gst|tax|vat)|(gst|tax|vat)\s*total/i,
  grand: /(grand|net|bill|final)\s*(total|amount|payable)|total\s*(due|payable|amount|inr)|amount\s*(due|payable)|balance\s*due|^\W*total\b/i,
  round: /round(ing)?[\s-]*(off|up|down)?/i,
  discount: /discount|\bdisc\b|coupon|promo|\boffer\b|\bless\b|\bsavings?\b/i,
  service: /service\s*(charge|chg)|\bsvc\b|\btip\b|gratuity|packing|packaging|delivery|convenience|platform\s*fee|handling/i,
  tax: /\b[csi]?gst\b|\bvat\b|\btax(es)?\b|\bcess\b/i,
  skip: /\b(cash|card|upi|visa|master(card)?|change|tender(ed)?|paid|payment|tel|phone|mob(ile)?|gstin|fssai|pan|invoice|inv|bill\s*(no|number)|order|table|kot|cashier|server|steward|thank|visit|token|ref|txn|auth|balance)\b/i,
  merchantNo: /invoice|bill|receipt|tax|gst|tel|phone|welcome|date|www|@|http/i
};

function lineMoney(line){
  // Thermal printers often turn the decimal point into a comma ("240,00"); read those as decimals too.
  const l = /\d\.\d{2}(?!\d)/.test(line) ? line : line.replace(/(\d),(\d{2})(?!\d)/g, "$1.$2");
  return { line: l, found: l.match(MONEY) || [] };
}

function parseDate(text){
  const now = Date.now() + 86400000;
  const ok = (y, m, d) => {
    if (y < 100) y += 2000;
    if (y < 2000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const t = Date.UTC(y, m - 1, d);
    if (new Date(t).getUTCDate() !== d || t > now) return null;
    return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  };
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m){ const r = ok(+m[1], +m[2], +m[3]); if (r) return r; }
  m = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\b/);
  if (m){ const r = ok(+m[3], +m[2], +m[1]); if (r) return r; }
  return null;
}

function cleanName(label, count){
  let name = label.replace(/[₹$€£]|\b(rs|inr)\b\.?/gi, " ").replace(/\s+/g, " ").trim(), qty = 1, m;
  if ((m = name.match(/^(\d{1,2})\s*[x×]\s+(.*)$/i))){ qty = +m[1]; name = m[2]; }
  else if (count >= 2 && (m = name.match(/^(.*?)\s+(\d{1,2})$/))){ qty = +m[2]; name = m[1]; }
  else name = name.replace(/^\d{1,2}[.)]\s+/, "");
  name = name.replace(/^[\s\-:|.,*#]+/, "").replace(/[\s\-:|.,*#@%]+$/, "").slice(0, 60);
  return { name: qty > 1 && name ? name + " ×" + qty : name, letters: (name.match(/[A-Za-zÀ-ɏ]/g) || []).length };
}

// Turns the text read off a bill into { merchant, date, items:[{name, amount}], tax, service, discount, round, subtotal, total }.
// Anything it can't find is 0 or null; the person always gets to check and fix it.
export function parseReceipt(text){
  const out = { merchant: "", date: null, items: [], tax: 0, service: 0, discount: 0, round: 0, subtotal: 0, total: 0 };
  const lines = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const taxLines = []; let taxTotal = null;
  out.date = parseDate(lines.join("\n"));
  lines.forEach((raw, idx) => {
    const { line, found } = lineMoney(raw);
    if (!found.length){
      if (!out.merchant && idx < 6 && (line.match(/[A-Za-z]/g) || []).length >= 3 && !RE.merchantNo.test(line) && !/\d{5,}/.test(line)) out.merchant = line.replace(/[^\w&'’.,\- ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      return;
    }
    const last = found[found.length - 1], amount = parseMoney(last), label = line.replace(MONEY, " ");
    if (isNaN(amount) || RE.saved.test(label)) return;
    if (RE.subtotal.test(label)){ out.subtotal = Math.abs(amount); return; }
    if (RE.taxTotal.test(label)){ taxTotal = Math.abs(amount); return; }
    if (RE.grand.test(label)){ out.total = Math.abs(amount); return; }
    if (RE.round.test(label)){ out.round += amount; return; }
    if (RE.discount.test(label)){ out.discount += Math.abs(amount); return; }
    if (RE.service.test(label)){ out.service += Math.abs(amount); return; }
    if (RE.tax.test(label)){ taxLines.push(Math.abs(amount)); return; }
    if (RE.skip.test(label)) return;
    const { name, letters } = cleanName(label, found.length);
    if (letters < 2) return;
    if (amount < 0){ out.discount += -amount; return; }
    if (amount > 0) out.items.push({ name, amount });
  });
  out.tax = taxTotal != null ? taxTotal : taxLines.reduce((a, b) => a + b, 0);
  return out;
}

// items: [{ name, amount, who:[memberId] }]. Each item is shared equally by the people ticked on it.
// tax, service and round are added, discount is taken off; that net amount is spread over people in proportion
// to what they ordered. Shares always add up to the total exactly.
// Returns { shares:{id:minor}, subtotal, extra, total } or { error }.
export function splitBill({ items, tax = 0, service = 0, discount = 0, round = 0 }, order){
  const base = {};
  order.forEach(id => { base[id] = 0; });
  let any = false;
  for (const it of items){
    if (!(it.amount > 0)) continue;
    any = true;
    if (!it.who.length) return { error: "Choose who shared " + (it.name ? "“" + it.name + "”" : "every item") + "." };
    const parts = largestRemainder(it.amount, it.who.map(() => 1));
    it.who.forEach((id, i) => { base[id] = (base[id] || 0) + parts[i]; });
  }
  if (!any) return { error: "Add at least one item with an amount." };
  const subtotal = order.reduce((a, id) => a + (base[id] || 0), 0);
  const extra = tax + service - discount + round, total = subtotal + extra;
  if (!(total > 0)) return { error: "The discount is bigger than the bill." };
  const ids = order.filter(id => base[id] > 0), sign = extra < 0 ? -1 : 1;
  const spread = largestRemainder(Math.abs(extra), ids.map(id => base[id]));
  const shares = {};
  ids.forEach((id, i) => { shares[id] = base[id] + sign * spread[i]; });
  return { shares, subtotal, extra, total };
}

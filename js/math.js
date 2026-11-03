// Pure money and splitting maths. No browser or network code here, so it is easy to test.
// All amounts are whole minor units (paise/cents).

export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function fmt(minor, cur){
  return (minor < 0 ? "-" : "") + cur + Math.abs(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtWhole(minor, cur){
  return (minor < 0 ? "-" : "") + cur + Math.abs(Math.round(minor / 100)).toLocaleString("en-IN");
}
export function parseMoney(str){
  const c = String(str == null ? "" : str).replace(/[,\s]/g, "");
  if (c === "") return NaN;
  const n = Number(c);
  return isFinite(n) ? Math.round(n * 100) : NaN;
}

// Split `total` into whole units in proportion to `weights`; the parts always add up to `total`.
export function largestRemainder(total, weights){
  const W = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map(w => total * w / W);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => i).sort((a, b) => (exact[b] - out[b]) - (exact[a] - out[a]) || a - b);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) out[order[i]]++;
  return out;
}

// parts: [{ id, v }]. v is minor units for "exact", a percent for "percent", a share count for "shares".
// Returns { shares: { id: minor }, info } or { error } or { pending, info }.
export function computeSplit(amount, type, parts, cur = ""){
  if (!parts.length) return { error: "Choose at least one person." };
  if (!(amount > 0)) return { error: null, info: "Enter an amount to see the split.", pending: true };
  const ids = parts.map(p => p.id);
  if (type === "exact"){
    const vals = parts.map(p => isNaN(p.v) ? 0 : p.v);
    const sum = vals.reduce((a, b) => a + b, 0);
    const shares = {}; ids.forEach((id, i) => shares[id] = vals[i]);
    if (sum !== amount) return { shares, error: "Amounts add up to " + fmt(sum, cur) + ". They need to add up to " + fmt(amount, cur) + " (" + (sum < amount ? fmt(amount - sum, cur) + " left" : fmt(sum - amount, cur) + " over") + ").", diff: amount - sum };
    return { shares, info: "All " + fmt(amount, cur) + " is assigned." };
  }
  let weights;
  if (type === "equal") weights = parts.map(() => 1);
  else if (type === "percent"){
    weights = parts.map(p => (isFinite(p.v) && p.v > 0) ? p.v : 0);
    const sum = weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 0.005) return { error: "Percentages add up to " + +sum.toFixed(2) + "%. They need to add up to 100%." };
  } else {
    weights = parts.map(p => (isFinite(p.v) && p.v > 0) ? p.v : 0);
    if (weights.reduce((a, b) => a + b, 0) <= 0) return { error: "Give at least one person a share." };
  }
  const minor = largestRemainder(amount, weights);
  const shares = {}; ids.forEach((id, i) => shares[id] = minor[i]);
  return { shares, info: type === "equal" ? "Each pays about " + fmt(Math.round(amount / parts.length), cur) + "." : "Split worked out." };
}

export function mname(G, id){ const m = G.members.find(m => m.id === id); return m ? m.name : "Removed person"; }

// G: { members:[{id}], expenses:[{payer, amount, shares}], payments:[{from,to,amount}] }
// net > 0 means the person gets money back; net < 0 means they owe.
export function balances(G){
  const paid = {}, share = {}, sent = {}, recv = {};
  G.members.forEach(m => { paid[m.id] = 0; share[m.id] = 0; sent[m.id] = 0; recv[m.id] = 0; });
  G.expenses.forEach(e => {
    paid[e.payer] = (paid[e.payer] || 0) + e.amount;
    for (const id in e.shares) share[id] = (share[id] || 0) + e.shares[id];
  });
  G.payments.forEach(p => { sent[p.from] = (sent[p.from] || 0) + p.amount; recv[p.to] = (recv[p.to] || 0) + p.amount; });
  const net = {};
  G.members.forEach(m => net[m.id] = paid[m.id] - share[m.id] + sent[m.id] - recv[m.id]);
  return { paid, share, sent, recv, net };
}

// Fewest payments that clear every balance.
export function settleUp(net){
  const cr = [], db = [];
  for (const id in net){ if (net[id] > 0) cr.push({ id, a: net[id] }); else if (net[id] < 0) db.push({ id, a: -net[id] }); }
  const out = [];
  while (cr.length && db.length){
    cr.sort((a, b) => b.a - a.a); db.sort((a, b) => b.a - a.a);
    const c = cr[0], d = db[0], a = Math.min(c.a, d.a);
    out.push({ from: d.id, to: c.id, amount: a });
    c.a -= a; d.a -= a;
    if (!c.a) cr.shift();
    if (!d.a) db.shift();
  }
  return out;
}

export function involved(G, id){
  return G.expenses.some(e => e.payer === id || (e.shares && id in e.shares)) || G.payments.some(p => p.from === id || p.to === id);
}

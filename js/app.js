import { sb, configured } from "./client.js";
import { MONTHS, fmt as fmtM, fmtWhole as fmtW, parseMoney, computeSplit, balances, settleUp, involved, mname } from "./math.js";
import { buildXlsx, groupSheets } from "./xlsx.js";

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const today = () => { const t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); };
const fmtDate = d => { const [, m, dd] = d.split("-").map(Number); return dd + " " + MONTHS[m - 1]; };
const safeName = s => (s || "group").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "group";

const app = $("#app"), chrome = $("#chrome"), dlg = $("#dlg");
const S = { boot: true, session: null, me: null, view: "loading", authMode: "in", groups: [], G: null, tab: "expenses", openId: null, preview: null };
let seq = 0, rt = null, D = null, refreshTimer = null, refreshSeq = 0;

/* There are no accounts or email: every device gets a silent, anonymous Supabase Auth session
   (no email involved), and signing in with a 4-digit PIN just links that session to a person
   via the pin_login/pin_signup RPCs. S.me is the resolved person, independent of S.session. */
const PIN_RE = /^[0-9]{4}$/;
async function ensureAnon(){
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session;
  const { data: d2, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return d2.session;
}

const cur = () => (S.G ? S.G.currency : "₹");
const fmt = m => fmtM(m, cur());
const fmtWhole = m => fmtW(m, cur());
const myId = () => (S.me ? S.me.id : null);
const who = id => (S.G && id === S.G.me ? "You" : mname(S.G, id));

function myName(){ return S.me ? S.me.name : ""; }
function myPin(){ return S.me ? S.me.pin : ""; }
function nice(e){
  const m = (e && e.message) || String(e);
  if (e && e.code === "23505") return "Someone in this group already has that name.";
  if (e && e.code === "23503") return "That person is part of an expense or payment, so they can't be removed.";
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return "Can't reach the server. Check your connection and try again.";
  if (/rate limit/i.test(m)) return "Too many tries. Wait a few minutes and try again.";
  return m;
}

let toastTimer = null;
function toast(msg, undo){
  const old = $("#toast"); if (old) old.remove();
  const t = document.createElement("div"); t.className = "toast"; t.id = "toast"; t.setAttribute("role", "status");
  t.innerHTML = "<span>" + esc(msg) + "</span>" + (undo ? '<button id="undoBtn">Undo</button>' : "");
  document.body.appendChild(t);
  if (undo) $("#undoBtn").onclick = () => { t.remove(); undo(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 7000);
}

/* ================= screens that are not a group ================= */
const LOGO_SVG = '<svg viewBox="0 0 40 40" width="26" height="26" fill="none" aria-hidden="true"><rect x="6" y="6" width="22" height="22" rx="6" stroke="#39ff8e" stroke-width="3"/><rect x="12" y="12" width="22" height="22" rx="6" stroke="#ff3ea8" stroke-width="3"/></svg>';
function header(right){
  return '<header class="top"><div class="tag"><span class="mark" aria-hidden="true">' + LOGO_SVG + '</span><div><strong>ShareSquare</strong><small>shared with your group</small></div></div>' + (right ? '<div class="right">' + right + "</div>" : "") + "</header>";
}
function renderLoading(text){
  app.innerHTML = header() + '<p class="lede" role="status" style="margin-top:28px">' + esc(text || "Loading…") + "</p>";
  chrome.innerHTML = "";
}
function renderError(e){
  app.innerHTML = header() + '<section class="paper" style="margin-top:22px"><p class="kicker">Something went wrong</p><h2>We couldn\'t load that</h2><p class="help">' + esc(nice(e)) + '</p><div class="actions" style="margin-top:0"><button class="primary" data-act="retry">Try again</button><button data-act="home">Back to groups</button></div></section>';
  chrome.innerHTML = "";
}
function renderSetup(){
  app.innerHTML = header() + '<h1>One more step</h1><p class="lede">Connect this app to your own Supabase project.</p>' +
    '<section class="paper setup" style="margin-top:22px"><p class="kicker">Setup</p><h2>Add your project details</h2><ol class="help">' +
    "<li>Create a new Supabase project and run <code>supabase/schema.sql</code> in its SQL Editor.</li>" +
    "<li>Open <code>js/config.js</code> and paste the project URL and the public anon key.</li>" +
    "<li>Reload this page.</li></ol><p class=\"note\">The README has the full steps.</p></section>";
  chrome.innerHTML = "";
}

function renderAuth(){
  const up = S.authMode === "up";
  const joining = /^#\/join\//.test(location.hash);
  const formTitle = up ? "Create account" : "Sign in";
  const lede = joining ? "You were invited to a group. " + (up ? "Create an account" : "Sign in") + " to join it." : "Split costs with friends. Everyone in a group sees the same ledger, live.";
  app.innerHTML = header() +
    '<div class="statusbar"><span class="dot" aria-hidden="true"></span>LIVE · REALTIME LEDGER</div>' +
    '<h1 class="headline"><span class="l1">Split costs.</span><span class="l2">Stay settled.</span></h1>' +
    '<div class="hero">' +
      '<div class="hero-copy">' +
        '<p class="lede">' + esc(lede) + '</p>' +
        '<form class="paper" id="authForm" novalidate style="margin-top:18px">' +
          '<p class="kicker">Account</p><h2>' + formTitle + '</h2><div class="stack">' +
          (up ? '<label>Your name<input id="aName" autocomplete="name" maxlength="40"></label>' : "") +
          '<label>' + (up ? "Choose a 4-digit PIN" : "Your 4-digit PIN") + '<input id="aPin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="••••"></label>' +
          '</div><div class="msg" id="aMsg" role="alert"></div><div class="actions"><button class="primary" type="submit">' + (up ? "Create account" : "Sign in") + "</button></div>" +
          (up ? '<p class="note" style="margin-top:10px">Keep your PIN somewhere safe — there\'s no recovery if you lose it.</p>' : "") +
          '<div class="links"><button type="button" class="linkbtn" data-act="mode" data-mode="' + (up ? "in" : "up") + '">' + (up ? "Already have an account? Sign in" : "New here? Create an account") + "</button></div>" +
        "</form>" +
      "</div>" +
      '<div class="livepanel" aria-hidden="true">' +
        '<div class="lp-head"><span class="dot"></span>ledger.live — goa-trip</div>' +
        '<div class="lp-body">' +
          '<div class="lp-line"><span class="lp-cm"># shared ledger, synced in real time</span></div>' +
          '<div class="lp-line"><span class="lp-kw">[group.goa-trip]</span></div>' +
          '<div class="lp-line"><span class="lp-key">members</span> = [<span class="lp-str">"asha"</span>, <span class="lp-str">"ravi"</span>, <span class="lp-str">"nina"</span>] + you</div>' +
          '<div class="lp-line"><span class="lp-key">currency</span> = <span class="lp-str">"₹"</span></div>' +
          '<div class="lp-line">&nbsp;</div>' +
          '<div class="lp-line"><span class="lp-kw">[group.goa-trip.balance]</span></div>' +
          '<div class="lp-line"><span class="lp-key">you_get</span> = <span class="lp-num">1,240</span></div>' +
          '<div class="lp-line"><span class="lp-key">status</span>  = <span class="lp-str">"settled after next payment"</span></div>' +
        "</div>" +
        '<div class="lp-foot"><span>3 members · 12 expenses</span><span class="ok">● synced</span></div>' +
      "</div>" +
    "</div>";
  chrome.innerHTML = "";
}
function setMsg(sel, text, ok){ const el = $(sel); if (!el) return; el.textContent = text || ""; el.className = "msg" + (text ? (ok ? " ok" : " bad") : ""); }

async function doAuth(){
  const up = S.authMode === "up";
  const pin = $("#aPin").value.trim();
  if (!PIN_RE.test(pin)) return setMsg("#aMsg", "Enter a 4-digit PIN.");
  const name = up ? $("#aName").value.trim() : "";
  if (up && !name) return setMsg("#aMsg", "Enter your name.");
  const btn = $("#authForm button[type=submit]"); btn.disabled = true; setMsg("#aMsg", "");
  try {
    await ensureAnon();
    const { data, error } = up
      ? await sb.rpc("pin_signup", { p_pin: pin, p_name: name })
      : await sb.rpc("pin_login", { p_pin: pin });
    if (error) throw error;
    S.me = Array.isArray(data) ? data[0] : data;
    return route();
  } catch (e){ setMsg("#aMsg", nice(e)); }
  const b = $("#authForm button[type=submit]"); if (b) b.disabled = false;
}

/* ----- group list ----- */
async function showList(){
  const my = ++seq; S.view = "list"; renderLoading();
  const { data, error } = await sb.from("groups").select("id,name,currency,members(count)").order("created_at", { ascending: false });
  if (my !== seq) return;
  if (error) return renderError(error);
  S.groups = data || []; renderList();
}
function renderList(){
  const gs = S.groups;
  app.innerHTML = header('<button data-act="signout">Sign out</button>') + "<h1>Your groups</h1>" +
    '<section class="paper" style="margin-top:18px"><p class="kicker">Groups</p>' +
    (gs.length ? gs.map(g => '<article class="item"><button class="main" data-act="open" data-id="' + g.id + '"><span class="gicon" aria-hidden="true">' + esc(g.name.trim().charAt(0)) + '</span><span class="mid"><strong>' + esc(g.name) + "</strong><small>" + ((g.members && g.members[0] && g.members[0].count) || 0) + ' people</small></span><span class="amt" aria-hidden="true">›</span></button></article>').join("") :
      '<div class="empty"><strong>No groups yet.</strong>Create one for a trip, a flat or a dinner, or join one with an invite link.</div>') +
    '<div class="actions"><button class="primary" data-act="newgroup">New group</button></div></section>' +
    '<section class="paper"><p class="kicker">Invited?</p><h2>Join a group</h2><p class="help">Paste the invite link, or type the 4-digit PIN you were sent.</p><form id="joinForm" class="actions" style="margin-top:0"><input id="joinCode" placeholder="Invite link or PIN" style="flex:1;min-width:180px" autocapitalize="none" autocomplete="off"><button type="submit">Join</button></form><div class="msg" id="joinMsg" role="alert"></div></section>';
  chrome.innerHTML = "";
}

/* ----- join ----- */
async function showJoin(code){
  const my = ++seq; S.view = "join"; renderLoading("Checking the invite…");
  const { data, error } = await sb.rpc("preview_group", { p_code: code });
  if (my !== seq) return;
  if (error) return renderError(error);
  if (!data){
    app.innerHTML = header() + '<section class="paper" style="margin-top:22px"><p class="kicker">Invite</p><h2>This invite link doesn\'t work</h2><p class="help">The code may have been typed wrong, or the group made a new link. Ask for a fresh invite.</p><button class="primary" data-act="home">Go to my groups</button></section>';
    chrome.innerHTML = ""; return;
  }
  if (data.already_member){ location.hash = "#/g/" + data.group_id; return; }
  S.preview = Object.assign({ code }, data); renderJoin();
}
function renderJoin(){
  const p = S.preview, free = p.free || [], mine = myName().toLowerCase();
  const pre = free.find(f => f.name.toLowerCase() === mine);
  app.innerHTML = header('<button data-act="home">My groups</button>') + "<h1>Join " + esc(p.name) + "</h1>" +
    '<p class="lede">Pick the name the group already uses for you, or join as someone new.</p>' +
    '<form class="paper" id="joinGo" novalidate style="margin-top:22px">' +
    free.map(f => '<label class="opt"><input type="radio" name="who" value="' + f.id + '"' + (pre && pre.id === f.id ? " checked" : "") + "> I'm " + esc(f.name) + "</label>").join("") +
    '<label class="opt"><input type="radio" name="who" value="new"' + (pre ? "" : " checked") + '> I\'m someone new</label>' +
    '<label id="newNameWrap" style="margin-top:8px">Your name in this group<input id="newName" maxlength="40" value="' + esc(myName()) + '"></label>' +
    '<div class="msg" id="jMsg" role="alert"></div><div class="actions"><button class="primary" type="submit">Join group</button></div></form>';
  chrome.innerHTML = ""; syncJoinName();
}
function syncJoinName(){
  const sel = document.querySelector('input[name="who"]:checked'), w = $("#newNameWrap");
  if (w) w.hidden = !sel || sel.value !== "new";
}
async function doJoin(){
  const sel = document.querySelector('input[name="who"]:checked'); if (!sel) return;
  const isNew = sel.value === "new", name = $("#newName").value.trim();
  if (isNew && !name) return setMsg("#jMsg", "Enter your name.");
  const btn = $("#joinGo button[type=submit]"); btn.disabled = true; setMsg("#jMsg", "");
  const { data, error } = await sb.rpc("join_group", { p_code: S.preview.code, p_member: isNew ? null : sel.value, p_name: isNew ? name : null });
  if (error){ setMsg("#jMsg", nice(error)); btn.disabled = false; return; }
  toast("You joined " + S.preview.name + "."); location.hash = "#/g/" + data;
}

/* ================= group data ================= */
async function fetchAll(make){
  const out = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function loadGroup(id){
  const gq = await sb.from("groups").select("*").eq("id", id).maybeSingle();
  if (gq.error) throw gq.error;
  if (!gq.data) return null;
  const [mem, exp, pay] = await Promise.all([
    fetchAll(() => sb.from("members").select("*").eq("group_id", id).order("created_at").order("id")),
    fetchAll(() => sb.from("expenses").select("*, expense_splits(member_id, amount_minor, input_value)").eq("group_id", id).order("created_at").order("id")),
    fetchAll(() => sb.from("payments").select("*").eq("group_id", id).order("created_at").order("id"))
  ]);
  const me = mem.find(m => m.person_id === myId());
  if (!me) return null;
  return {
    id: gq.data.id, name: gq.data.name, currency: gq.data.currency, code: gq.data.invite_code, createdBy: gq.data.created_by, me: me.id,
    members: mem.map(m => ({ id: m.id, name: m.name, person_id: m.person_id })),
    expenses: exp.map(r => ({
      id: r.id, desc: r.description, amount: Number(r.amount_minor), payer: r.paid_by, date: r.expense_date, type: r.split_type, ts: Date.parse(r.created_at) || 0,
      shares: Object.fromEntries(r.expense_splits.map(s => [s.member_id, Number(s.amount_minor)])),
      parts: r.expense_splits.map(s => ({ id: s.member_id, v: Number(s.input_value) }))
    })),
    payments: pay.map(p => ({ id: p.id, from: p.from_member, to: p.to_member, amount: Number(p.amount_minor), date: p.payment_date, ts: Date.parse(p.created_at) || 0 }))
  };
}
async function openGroup(id){
  if (S.G && S.G.id === id && S.view === "group"){ renderGroup(); return; }
  const my = ++seq; S.view = "group"; renderLoading();
  let g;
  try { g = await loadGroup(id); } catch (e){ if (my === seq) renderError(e); return; }
  if (my !== seq) return;
  if (!g){ toast("We couldn't find that group, or you're not in it."); location.hash = ""; return; }
  S.G = g; S.tab = "expenses"; S.openId = null; subscribe(id); renderGroup();
}
async function refresh(){
  if (!S.G) return;
  const my = ++refreshSeq, id = S.G.id;
  const g = await loadGroup(id);
  if (my !== refreshSeq || !S.G || S.G.id !== id) return;
  if (!g){ toast("This group was deleted, or you were removed from it."); location.hash = ""; return; }
  S.G = g; renderGroup();
}
function schedule(){ clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(() => {}), 350); }
function subscribe(id){
  unsubscribe();
  rt = sb.channel("group-" + id);
  for (const t of ["members", "expenses", "expense_splits", "payments"]) rt.on("postgres_changes", { event: "*", schema: "public", table: t, filter: "group_id=eq." + id }, schedule);
  rt.on("postgres_changes", { event: "*", schema: "public", table: "groups", filter: "id=eq." + id }, schedule);
  rt.subscribe();
}
function unsubscribe(){ if (rt){ sb.removeChannel(rt); rt = null; } }
function leaveGroup(){ unsubscribe(); S.G = null; S.openId = null; clearTimeout(refreshTimer); }

/* ================= group view ================= */
function splitLabel(e){
  const n = Object.keys(e.shares).length;
  return ({ equal: "split equally between " + n, exact: "exact amounts for " + n, percent: "split by percentage between " + n, shares: "split by shares between " + n })[e.type] + (n === 1 ? " person" : " people");
}
function renderGroup(){
  const G = S.G; if (!G) return;
  const b = balances(G), total = G.expenses.reduce((a, e) => a + e.amount, 0), net = b.net[G.me] || 0;
  let h = header('<button data-act="home">All groups</button>') + "<h1>" + esc(G.name) + "</h1>";
  h += '<div class="slips"><div class="slip"><div class="k">Total spent</div><div class="v">' + fmtWhole(total) + '</div></div><div class="slip"><div class="k">Expenses</div><div class="v">' + G.expenses.length + '</div></div><div class="slip hi' + (net === 0 ? ' txt' : '') + '"><div class="k">' + (net > 0 ? "You are owed" : net < 0 ? "You owe" : "Your balance") + '</div><div class="v">' + (net === 0 ? "Settled" : fmtWhole(Math.abs(net))) + "</div></div></div>";
  h += S.tab === "balances" ? viewBalances(G, b) : S.tab === "group" ? viewGroup(G) : viewExpenses(G);
  app.innerHTML = h;
  chrome.innerHTML = (S.tab !== "group" ? '<button class="primary fab" data-act="add">+ Add expense</button>' : "") +
    '<nav class="bar" aria-label="Sections"><div class="in">' +
    [["expenses", "Expenses"], ["balances", "Balances"], ["group", "Group"]].map(([k, l]) => '<button data-act="tab" data-tab="' + k + '"' + (S.tab === k ? ' aria-current="page"' : "") + ">" + l + "</button>").join("") + "</div></nav>";
}
function viewExpenses(G){
  const items = G.expenses.map(e => ({ k: "e", x: e })).concat(G.payments.map(p => ({ k: "p", x: p })));
  items.sort((a, b) => b.x.date.localeCompare(a.x.date) || b.x.ts - a.x.ts);
  if (!items.length) return '<section class="paper"><div class="empty"><strong>No expenses yet.</strong>Tap “Add expense” when someone pays for the group. Invite the others from the Group tab.</div></section>';
  let h = '<section class="paper"><p class="kicker">Ledger</p>';
  for (const it of items){
    const x = it.x, open = S.openId === x.id;
    if (it.k === "e"){
      h += '<article class="item"><button class="main" data-act="toggle" data-id="' + x.id + '" aria-expanded="' + open + '"><span class="date">' + fmtDate(x.date) + '</span><span class="mid"><strong>' + esc(x.desc) + "</strong><small>" + esc(who(x.payer)) + " paid " + fmt(x.amount) + " · " + splitLabel(x) + '</small></span><span class="amt">' + fmt(x.amount) + "</span></button>";
      if (open) h += '<div class="detail"><ul>' + Object.keys(x.shares).map(id => "<li><span>" + esc(who(id)) + "</span><span>" + fmt(x.shares[id]) + "</span></li>").join("") + '</ul><div class="actions" style="margin-top:6px"><button class="small" data-act="edit" data-id="' + x.id + '">Edit</button><button class="small danger" data-act="del" data-id="' + x.id + '">Delete</button></div></div>';
      h += "</article>";
    } else {
      h += '<article class="item"><button class="main" data-act="toggle" data-id="' + x.id + '" aria-expanded="' + open + '"><span class="date">' + fmtDate(x.date) + '</span><span class="mid"><strong>' + esc(who(x.from)) + " paid " + esc(who(x.to)) + "</strong><small>Payment to settle up</small></span><span class=\"amt in\">" + fmt(x.amount) + "</span></button>";
      if (open) h += '<div class="detail"><div class="actions" style="margin-top:0"><button class="small danger" data-act="delpay" data-id="' + x.id + '">Delete payment</button></div></div>';
      h += "</article>";
    }
  }
  return h + "</section>";
}
function viewBalances(G, b){
  let h = '<section class="paper"><p class="kicker">Balances</p><h2>Who is owed what</h2>';
  h += G.members.map(m => {
    const n = b.net[m.id];
    return '<div class="bal"><strong>' + esc(m.name) + (m.id === G.me ? ' <em class="you">you</em>' : "") + "</strong>" + (n > 0 ? '<span class="pos">gets back ' + fmt(n) + "</span>" : n < 0 ? '<span class="neg">owes ' + fmt(-n) + "</span>" : '<span class="zero">settled up</span>') + "</div>";
  }).join("") + "</section>";
  const sug = settleUp(b.net);
  h += '<section class="paper"><p class="kicker">Settle up</p><h2>' + (sug.length ? "Fewest payments to clear everything" : "Everyone is settled up") + "</h2>";
  if (sug.length) h += sug.map((s, i) => {
    const text = s.from === G.me ? "You pay " + esc(mname(G, s.to)) : s.to === G.me ? esc(mname(G, s.from)) + " pays you" : esc(mname(G, s.from)) + " pays " + esc(mname(G, s.to));
    return '<div class="settle"><div class="who">' + text + '</div><span class="stamp">' + fmt(s.amount) + '</span><button class="small" data-act="record" data-i="' + i + '">Record</button></div>';
  }).join("");
  else h += '<p class="help">Nothing to pay. New expenses will show up here.</p>';
  h += '<div class="actions"><button class="small" data-act="pay">Record another payment</button><button class="small pill" data-act="share">Share summary</button></div></section>';
  return h;
}
function inviteLink(G){ return location.origin + location.pathname + "#/join/" + G.code; }
function viewGroup(G){
  const isOwner = G.createdBy === myId();
  return '<section class="paper"><p class="kicker">Group</p><h2>Details</h2><div class="stack"><label>Group name<input id="gName" value="' + esc(G.name) + '" maxlength="60"></label><label>Currency symbol<input id="cur" value="' + esc(G.currency) + '" maxlength="4" style="max-width:120px"></label></div><div class="msg" id="gMsg" role="alert"></div></section>' +
    '<section class="paper"><p class="kicker">Invite</p><h2>Add people with a PIN</h2><p class="help">Anyone with this PIN can join after signing in, and will see every expense. Share it only with people in the group.</p><div class="codebox"><span class="stamp">' + esc(G.code) + '</span></div><div class="actions"><button class="pill" data-act="invite">Share invite link</button><button data-act="copylink">Copy link</button></div><div class="actions"><button class="small" data-act="rotate">Make a new PIN</button></div><p class="note" style="margin:8px 0 0">A new PIN stops the old one from working. People already in the group stay.</p></section>' +
    '<section class="paper"><p class="kicker">People</p><h2>Who shares costs</h2>' +
    G.members.map(m => {
      const canRemove = !m.person_id && !involved(G, m.id) && G.members.length > 2;
      return '<div class="person"><span>' + esc(m.name) + (m.id === G.me ? ' <em class="you">you</em>' : "") + "</span><small>" + (m.person_id ? "joined" : "not joined yet") + '</small><button class="rn" data-act="rename" data-id="' + m.id + '" aria-label="Rename ' + esc(m.name) + '">Rename</button>' + (canRemove ? '<button class="ghost small" data-act="rmmember" data-id="' + m.id + '" aria-label="Remove ' + esc(m.name) + '">Remove</button>' : "") + "</div>";
    }).join("") +
    '<div class="actions"><input id="newMember" placeholder="Add a person" style="flex:1;min-width:150px" maxlength="40"><button data-act="addmember">Add</button></div><div class="msg" id="memMsg" role="alert"></div></section>' +
    '<section class="paper"><p class="kicker">Save</p><h2>Export to Excel</h2><p class="help">Expenses with each person\'s share, balances, settle-up and payments, in one workbook.</p><div class="actions" style="margin-top:0"><button class="primary" data-act="xlsx">Download Excel</button></div></section>' +
    '<section class="paper"><p class="kicker">Account</p><h2>Your PIN</h2><p class="help">Use this 4-digit PIN to sign in on any device. Keep it to yourself — there\'s no recovery if you lose it.</p><div class="codebox"><span class="stamp">' + esc(myPin()) + '</span></div><div class="actions" style="margin-top:0"><button data-act="signout">Sign out</button></div></section>' +
    '<section class="paper"><p class="kicker">Careful</p><h2>Delete this group</h2>' + (isOwner ? '<p class="help">Removes the group, every expense and payment, for everyone. This can\'t be undone.</p><button class="danger" data-act="delgroup">Delete group</button>' : '<p class="help">Only the person who created the group can delete it.</p>') + "</section>";
}

/* ================= dialogs ================= */
function showDlg(html){ dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); }
function closeDlg(){ if (dlg.open) dlg.close(); }
dlg.addEventListener("click", e => { if (e.target === dlg) closeDlg(); });

function openCreateGroup(){
  let c = "₹"; try { c = localStorage.getItem("ss_cur") || "₹"; } catch (e) {}
  showDlg('<form id="gForm" novalidate><h2>New group</h2><label>Group name<input id="gn" placeholder="Goa trip" maxlength="60"></label>' +
    '<label>Currency symbol<input id="gc" value="' + esc(c) + '" maxlength="4" style="max-width:120px"></label>' +
    '<label>Other people, one per line (they can join later with an invite link)<textarea id="gm" placeholder="Ravi&#10;Meena"></textarea></label>' +
    '<div class="note">You are added automatically as ' + esc(myName()) + ".</div><div class=\"err\" id=\"gErr\" role=\"alert\"></div>" +
    '<div class="actions" style="margin-top:0"><button type="button" data-act="close">Cancel</button><span class="spacer"></span><button class="primary" type="submit">Create group</button></div></form>');
  $("#gForm").onsubmit = async ev => {
    ev.preventDefault();
    const name = $("#gn").value.trim(), cu = $("#gc").value.trim() || "₹";
    const others = $("#gm").value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (!name) return ($("#gErr").textContent = "Give the group a name.");
    const btn = $("#gForm button[type=submit]"); btn.disabled = true;
    const { data, error } = await sb.rpc("create_group", { p_name: name, p_currency: cu, p_my_name: myName(), p_others: others });
    if (error){ $("#gErr").textContent = nice(error); btn.disabled = false; return; }
    try { localStorage.setItem("ss_cur", cu); } catch (e) {}
    closeDlg(); location.hash = "#/g/" + data;
  };
  $("#gn").focus();
}

function openRename(id){
  const m = S.G.members.find(x => x.id === id); if (!m) return;
  showDlg('<form id="rnForm" novalidate><h2>Rename</h2><label>Name<input id="rnName" maxlength="40" value="' + esc(m.name) + '"></label><div class="err" id="rnErr" role="alert"></div><div class="actions" style="margin-top:0"><button type="button" data-act="close">Cancel</button><span class="spacer"></span><button class="primary" type="submit">Save</button></div></form>');
  $("#rnForm").onsubmit = async ev => {
    ev.preventDefault();
    const name = $("#rnName").value.trim(); if (!name) return ($("#rnErr").textContent = "Enter a name.");
    const { error } = await sb.from("members").update({ name }).eq("id", id);
    if (error) return ($("#rnErr").textContent = nice(error));
    closeDlg(); await refresh(); toast("Renamed.");
  };
  $("#rnName").focus(); $("#rnName").select();
}

/* ----- expense dialog ----- */
function openExpense(id){
  const G = S.G, ex = id ? G.expenses.find(e => e.id === id) : null;
  D = { id: ex ? ex.id : null, type: ex ? ex.type : "equal", checked: {}, vals: {} };
  G.members.forEach(m => {
    const p = ex ? ex.parts.find(p => p.id === m.id) : null;
    D.checked[m.id] = ex ? !!p : true;
    D.vals[m.id] = p ? partDisplay(ex.type, p.v) : (D.type === "shares" ? "1" : "");
  });
  showDlg('<form id="eForm" novalidate><h2>' + (ex ? "Edit expense" : "Add expense") + "</h2>" +
    '<label>What was it for<input id="eDesc" placeholder="Dinner at the beach shack" maxlength="80" value="' + esc(ex ? ex.desc : "") + '"></label>' +
    '<div class="two"><label>Amount (' + esc(G.currency) + ')<input id="eAmt" inputmode="decimal" placeholder="0.00" value="' + (ex ? (ex.amount / 100).toFixed(2) : "") + '"></label>' +
    '<label>Date<input id="eDate" type="date" value="' + (ex ? ex.date : today()) + '"></label></div>' +
    '<label>Paid by<select id="ePayer">' + G.members.map(m => '<option value="' + m.id + '"' + ((ex ? ex.payer : G.me) === m.id ? " selected" : "") + ">" + esc(m.name) + (m.id === G.me ? " (you)" : "") + "</option>").join("") + "</select></label>" +
    '<div><div class="note" style="margin-bottom:6px">How to split</div><div class="seg" id="eSeg">' +
    [["equal", "Equal"], ["exact", "Exact"], ["percent", "Percent"], ["shares", "Shares"]].map(([k, l]) => '<button type="button" data-type="' + k + '" aria-pressed="' + (D.type === k) + '">' + l + "</button>").join("") + "</div></div>" +
    '<div id="eParts"></div><div class="hint" id="eHint"></div><div class="err" id="eErr" role="alert"></div>' +
    '<div class="actions" style="margin-top:0"><button type="button" data-act="close">Cancel</button><span class="spacer"></span><button class="primary" type="submit">Save expense</button></div></form>');
  renderParts(); updateCalc();
  $("#eSeg").onclick = ev => {
    const b = ev.target.closest("button"); if (!b) return;
    D.type = b.dataset.type;
    S.G.members.forEach(m => { D.vals[m.id] = D.type === "shares" ? "1" : ""; });
    $("#eSeg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.type === D.type)));
    renderParts(); updateCalc();
  };
  $("#eForm").addEventListener("input", ev => { const t = ev.target; if (t.dataset.v) D.vals[t.dataset.v] = t.value; updateCalc(); });
  $("#eForm").addEventListener("change", ev => { const t = ev.target; if (t.dataset.m){ D.checked[t.dataset.m] = t.checked; renderParts(); updateCalc(); } });
  $("#eForm").onsubmit = ev => { ev.preventDefault(); saveExpense(); };
  if (!ex) $("#eDesc").focus();
}
function partDisplay(type, v){ return type === "exact" ? (v / 100).toFixed(2) : type === "equal" ? "" : String(v); }
function renderParts(){
  const eq = D.type === "equal";
  $("#eParts").innerHTML = S.G.members.map(m => {
    const on = D.checked[m.id];
    return '<div class="prow' + (on ? "" : " off") + (eq ? " eq" : "") + '"><label class="nm" style="flex-direction:row;font:600 17px var(--serif);color:var(--ink)"><input type="checkbox" data-m="' + m.id + '"' + (on ? " checked" : "") + ' aria-label="Include ' + esc(m.name) + '"><span>' + esc(m.name) + "</span></label>" +
      (eq ? "" : '<input class="pv" data-v="' + m.id + '" inputmode="decimal" aria-label="' + esc(m.name) + (D.type === "exact" ? " amount" : D.type === "percent" ? " percent" : " shares") + '" placeholder="' + (D.type === "exact" ? "0.00" : D.type === "percent" ? "%" : "shares") + '" value="' + esc(D.vals[m.id]) + '"' + (on ? "" : " disabled") + ">") +
      '<span class="calc" data-c="' + m.id + '"></span></div>';
  }).join("");
}
function draftParts(){
  return S.G.members.filter(m => D.checked[m.id]).map(m => ({
    id: m.id,
    v: D.type === "equal" ? 1 : D.type === "exact" ? parseMoney(D.vals[m.id] || "0") : Number(String(D.vals[m.id] || "").replace(/,/g, ""))
  }));
}
function updateCalc(){
  const amount = parseMoney($("#eAmt").value), r = computeSplit(amount, D.type, draftParts(), cur());
  S.G.members.forEach(m => { const el = document.querySelector('[data-c="' + m.id + '"]'); if (el) el.textContent = (r.shares && D.checked[m.id] && r.shares[m.id] != null) ? fmt(r.shares[m.id]) : ""; });
  const hint = $("#eHint"); hint.className = "hint" + (r.error ? " bad" : (r.pending ? "" : " good")); hint.textContent = r.error || r.info || "";
  return r;
}
async function saveExpense(){
  const err = $("#eErr"); err.textContent = "";
  const desc = $("#eDesc").value.trim(), amount = parseMoney($("#eAmt").value), date = $("#eDate").value, payer = $("#ePayer").value;
  if (!desc){ err.textContent = "Say what the expense was for."; $("#eDesc").focus(); return; }
  if (!(amount > 0)){ err.textContent = "Enter an amount above zero."; $("#eAmt").focus(); return; }
  if (!date){ err.textContent = "Pick a date."; return; }
  const parts = draftParts(), r = computeSplit(amount, D.type, parts, cur());
  if (r.error){ err.textContent = r.error; return; }
  const btn = $("#eForm button[type=submit]"); btn.disabled = true; btn.textContent = "Saving…";
  const editing = !!D.id;
  try {
    await rpcSave({ id: D.id, desc, amount, payer, date, type: D.type, splits: parts.map(p => ({ member_id: p.id, amount_minor: r.shares[p.id], input_value: D.type === "equal" ? 1 : p.v })) });
    closeDlg(); await refresh(); toast(editing ? "Expense updated." : "Expense added.");
  } catch (e){ err.textContent = nice(e); btn.disabled = false; btn.textContent = "Save expense"; }
}
async function rpcSave(x){
  const { error } = await sb.rpc("save_expense", { p_id: x.id, p_group: S.G.id, p_desc: x.desc, p_amount: x.amount, p_paid_by: x.payer, p_date: x.date, p_type: x.type, p_splits: x.splits });
  if (error) throw error;
}

function openPayDialog(pre){
  const G = S.G, opts = sel => G.members.map(m => '<option value="' + m.id + '"' + (sel === m.id ? " selected" : "") + ">" + esc(m.name) + (m.id === G.me ? " (you)" : "") + "</option>").join("");
  showDlg('<form id="pForm" novalidate><h2>Record a payment</h2><p class="help" style="margin:0">Use this when someone pays another person back outside the app.</p>' +
    '<div class="two"><label>Paid by<select id="pFrom">' + opts(pre ? pre.from : G.me) + '</select></label><label>Paid to<select id="pTo">' + opts(pre ? pre.to : (G.members.find(m => m.id !== G.me) || G.members[0]).id) + "</select></label></div>" +
    '<div class="two"><label>Amount (' + esc(G.currency) + ')<input id="pAmt" inputmode="decimal" placeholder="0.00" value="' + (pre && pre.amount ? (pre.amount / 100).toFixed(2) : "") + '"></label><label>Date<input id="pDate" type="date" value="' + today() + '"></label></div>' +
    '<div class="err" id="pErr" role="alert"></div><div class="actions" style="margin-top:0"><button type="button" data-act="close">Cancel</button><span class="spacer"></span><button class="primary" type="submit">Save payment</button></div></form>');
  $("#pForm").onsubmit = async ev => {
    ev.preventDefault();
    const from = $("#pFrom").value, to = $("#pTo").value, amount = parseMoney($("#pAmt").value), date = $("#pDate").value;
    if (from === to) return ($("#pErr").textContent = "Pick two different people.");
    if (!(amount > 0)) return ($("#pErr").textContent = "Enter an amount above zero.");
    if (!date) return ($("#pErr").textContent = "Pick a date.");
    const btn = $("#pForm button[type=submit]"); btn.disabled = true;
    const { error } = await sb.from("payments").insert({ group_id: S.G.id, from_member: from, to_member: to, amount_minor: amount, payment_date: date });
    if (error){ $("#pErr").textContent = nice(error); btn.disabled = false; return; }
    closeDlg(); await refresh(); toast("Payment recorded.");
  };
}

/* ================= summary + export ================= */
function summaryText(G){
  const b = balances(G), sug = settleUp(b.net);
  let t = G.name + "\nTotal spent: " + fmt(G.expenses.reduce((a, e) => a + e.amount, 0)) + "\n\nBalances\n";
  t += G.members.map(m => "• " + m.name + ": " + (b.net[m.id] > 0 ? "gets back " + fmt(b.net[m.id]) : b.net[m.id] < 0 ? "owes " + fmt(-b.net[m.id]) : "settled up")).join("\n");
  t += "\n\nTo settle up\n" + (sug.length ? sug.map(s => "• " + mname(G, s.from) + " pays " + mname(G, s.to) + " " + fmt(s.amount)).join("\n") : "Everyone is settled up.");
  return t;
}
function download(blob, name){
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function showText(title, text){ showDlg('<form method="dialog"><h2>' + esc(title) + '</h2><textarea readonly style="min-height:200px">' + esc(text) + '</textarea><div class="actions" style="margin-top:0"><span class="spacer"></span><button class="primary" type="submit">Done</button></div></form>'); }
async function shareOrCopy(title, text, url){
  if (navigator.share){ try { await navigator.share({ title, text, url }); return; } catch (e){ if (e && e.name === "AbortError") return; } }
  const full = url ? text + "\n" + url : text;
  if (navigator.clipboard){ try { await navigator.clipboard.writeText(full); toast("Copied. Paste it into your chat."); return; } catch (e){} }
  showText(title, full);
}

/* ================= actions ================= */
async function run(fn){ try { await fn(); } catch (e){ toast(nice(e)); } }
document.addEventListener("click", e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  const act = t.dataset.act, G = S.G;
  run(async () => {
    switch (act){
      case "close": closeDlg(); break;
      case "retry": route(); break;
      case "home": if (location.hash) location.hash = ""; else route(); break;
      case "mode": S.authMode = t.dataset.mode; renderAuth(); break;
      case "signout": {
        const { error } = await sb.auth.signOut(); if (error) throw error;
        S.me = null; S.groups = []; S.authMode = "in"; leaveGroup();
        route();
        break;
      }
      case "open": location.hash = "#/g/" + t.dataset.id; break;
      case "newgroup": openCreateGroup(); break;
      case "tab": S.tab = t.dataset.tab; renderGroup(); window.scrollTo(0, 0); break;
      case "add": openExpense(null); break;
      case "edit": openExpense(t.dataset.id); break;
      case "toggle": S.openId = S.openId === t.dataset.id ? null : t.dataset.id; renderGroup(); break;
      case "del": {
        const rec = G.expenses.find(x => x.id === t.dataset.id); if (!rec) break;
        const { error } = await sb.from("expenses").delete().eq("id", rec.id); if (error) throw error;
        S.openId = null; await refresh();
        toast("Expense deleted.", () => run(async () => {
          await rpcSave({ id: null, desc: rec.desc, amount: rec.amount, payer: rec.payer, date: rec.date, type: rec.type, splits: rec.parts.map(p => ({ member_id: p.id, amount_minor: rec.shares[p.id], input_value: p.v })) });
          await refresh(); toast("Expense restored.");
        }));
        break;
      }
      case "delpay": {
        const rec = G.payments.find(x => x.id === t.dataset.id); if (!rec) break;
        const { error } = await sb.from("payments").delete().eq("id", rec.id); if (error) throw error;
        S.openId = null; await refresh();
        toast("Payment deleted.", () => run(async () => {
          const r = await sb.from("payments").insert({ group_id: G.id, from_member: rec.from, to_member: rec.to, amount_minor: rec.amount, payment_date: rec.date });
          if (r.error) throw r.error; await refresh(); toast("Payment restored.");
        }));
        break;
      }
      case "record": {
        const s = settleUp(balances(G).net)[Number(t.dataset.i)]; if (!s) break;
        t.disabled = true;
        const { error } = await sb.from("payments").insert({ group_id: G.id, from_member: s.from, to_member: s.to, amount_minor: s.amount, payment_date: today() });
        if (error){ t.disabled = false; throw error; }
        await refresh(); toast(who(s.from) + " paid " + who(s.to) + " " + fmt(s.amount) + ".");
        break;
      }
      case "pay": openPayDialog(null); break;
      case "share": await shareOrCopy(G.name, summaryText(G)); break;
      case "invite": await shareOrCopy("Join " + G.name, 'Join "' + G.name + '" on ShareSquare so we can split costs:', inviteLink(G)); break;
      case "copylink":
        if (navigator.clipboard){ try { await navigator.clipboard.writeText(inviteLink(G)); toast("Invite link copied."); break; } catch (e2){} }
        showText("Invite link", inviteLink(G)); break;
      case "rotate":
        if (!confirm("Make a new PIN? The old one will stop working.")) break;
        { const { error } = await sb.rpc("rotate_invite_code", { p_group: G.id }); if (error) throw error; await refresh(); toast("New PIN ready."); }
        break;
      case "rename": openRename(t.dataset.id); break;
      case "addmember": {
        const inp = $("#newMember"), name = inp.value.trim();
        if (!name) return setMsg("#memMsg", "Type a name first.");
        if (G.members.some(m => m.name.toLowerCase() === name.toLowerCase())) return setMsg("#memMsg", name + " is already in this group.");
        const { error } = await sb.from("members").insert({ group_id: G.id, name });
        if (error) return setMsg("#memMsg", nice(error));
        await refresh(); toast(name + " added. Share the invite link or PIN so they can join.");
        break;
      }
      case "rmmember": { const { error } = await sb.from("members").delete().eq("id", t.dataset.id); if (error) throw error; await refresh(); break; }
      case "xlsx": download(buildXlsx(groupSheets(G)), safeName(G.name) + "-" + today() + ".xlsx"); toast("Excel file downloaded."); break;
      case "delgroup":
        if (confirm('Delete "' + G.name + '" and everything in it, for everyone? This can\'t be undone.')){
          const { error } = await sb.from("groups").delete().eq("id", G.id); if (error) throw error;
          leaveGroup(); toast("Group deleted."); location.hash = "";
        }
        break;
    }
  });
});
document.addEventListener("submit", e => {
  const id = e.target.id;
  if (id === "authForm"){ e.preventDefault(); doAuth(); }
  else if (id === "joinGo"){ e.preventDefault(); doJoin(); }
  else if (id === "joinForm"){
    e.preventDefault();
    const raw = $("#joinCode").value.trim(); if (!raw) return setMsg("#joinMsg", "Paste the invite link, or type the PIN.");
    const code = decodeURIComponent(raw.split("/").pop().split("#").pop()).trim();
    location.hash = "#/join/" + encodeURIComponent(code);
  }
});
document.addEventListener("change", e => {
  if (e.target.name === "who") syncJoinName();
  if (!S.G || S.view !== "group") return;
  if (e.target.id === "gName" || e.target.id === "cur"){
    const patch = e.target.id === "gName" ? { name: e.target.value.trim() } : { currency: e.target.value.trim() };
    const v = Object.values(patch)[0];
    if (!v){ setMsg("#gMsg", "That can't be empty."); return; }
    run(async () => {
      const { error } = await sb.from("groups").update(patch).eq("id", S.G.id);
      if (error) throw error;
      await refresh();
    });
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.id === "newMember"){ e.preventDefault(); const b = document.querySelector('[data-act="addmember"]'); if (b) b.click(); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.G && S.view === "group") schedule(); });

/* ================= routing + start ================= */
function parseHash(){
  const h = location.hash.replace(/^#\/?/, ""), i = h.indexOf("/");
  return i < 0 ? { a: h, b: "" } : { a: h.slice(0, i), b: decodeURIComponent(h.slice(i + 1)) };
}
async function route(){
  closeDlg();
  if (!configured) return renderSetup();
  if (S.boot) return renderLoading();
  if (!S.me){ leaveGroup(); S.view = "auth"; return renderAuth(); }
  const { a, b } = parseHash();
  try {
    if (a === "join" && b){ leaveGroup(); return await showJoin(b); }
    if (a === "g" && b) return await openGroup(b);
    leaveGroup(); await showList();
  } catch (e){ renderError(e); }
}

if (!configured){ renderSetup(); }
else {
  renderLoading();
  window.addEventListener("hashchange", route);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
    S.session = session;
  });
  (async () => {
    try {
      S.session = await ensureAnon();
      const { data, error } = await sb.rpc("whoami");
      if (!error && Array.isArray(data) && data.length) S.me = data[0];
    } catch (e) {}
    S.boot = false;
    route();
  })();
}

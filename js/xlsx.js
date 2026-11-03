// Builds a real .xlsx file in the browser (no libraries). Money cells are numbers, not text.
import { balances, settleUp, mname } from "./math.js";

export function groupSheets(G){
  const b = balances(G), M = v => ({ m: v / 100 });
  const exp = [["Date", "Description", "Paid by", "Amount", "Split type"].concat(G.members.map(m => m.name + " share"))];
  G.expenses.slice().sort((a, c) => a.date.localeCompare(c.date) || a.ts - c.ts).forEach(e =>
    exp.push([e.date, e.desc, mname(G, e.payer), M(e.amount), e.type].concat(G.members.map(m => e.shares[m.id] != null ? M(e.shares[m.id]) : ""))));
  const pay = [["Date", "Paid by", "Paid to", "Amount"]];
  G.payments.slice().sort((a, c) => a.date.localeCompare(c.date) || a.ts - c.ts).forEach(p => pay.push([p.date, mname(G, p.from), mname(G, p.to), M(p.amount)]));
  const bal = [["Person", "Paid for the group", "Their share of costs", "Payments sent", "Payments received", "Net (positive = gets back)"]];
  G.members.forEach(m => bal.push([m.name, M(b.paid[m.id]), M(b.share[m.id]), M(b.sent[m.id]), M(b.recv[m.id]), M(b.net[m.id])]));
  const set = [["Who pays", "Who gets paid", "Amount"]];
  settleUp(b.net).forEach(s => set.push([mname(G, s.from), mname(G, s.to), M(s.amount)]));
  return [
    { name: "Expenses", widths: [12, 30, 16, 12, 12].concat(G.members.map(() => 16)), rows: exp },
    { name: "Balances", widths: [18, 20, 22, 16, 18, 26], rows: bal },
    { name: "Settle up", widths: [18, 18, 14], rows: set },
    { name: "Payments", widths: [12, 18, 18, 14], rows: pay }
  ];
}

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b){ let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function makeZip(files){
  const enc = new TextEncoder(), chunks = [], central = []; let offset = 0;
  for (const f of files){
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cSize = central.reduce((a, b) => a + b.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function colName(n){ let s = ""; while (n > 0){ const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
const xe = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function sheetXml(sh){
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  x += "<cols>" + sh.widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("") + "</cols><sheetData>";
  sh.rows.forEach((row, ri) => {
    const r = ri + 1; x += '<row r="' + r + '">';
    row.forEach((c, ci) => {
      const ref = colName(ci + 1) + r;
      if (c === "" || c == null) return;
      if (typeof c === "object") x += '<c r="' + ref + '" s="2"><v>' + c.m + "</v></c>";
      else if (typeof c === "number") x += '<c r="' + ref + '"><v>' + c + "</v></c>";
      else x += '<c r="' + ref + '" t="inlineStr"' + (ri === 0 ? ' s="1"' : "") + "><is><t>" + xe(c) + "</t></is></c>";
    });
    x += "</row>";
  });
  return x + "</sheetData></worksheet>";
}

export function buildXlsx(sheets){
  const enc = new TextEncoder(), H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', f = (n, s) => ({ name: n, data: enc.encode(s) });
  const files = [
    f("[Content_Types].xml", H + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") + "</Types>"),
    f("_rels/.rels", H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    f("xl/workbook.xml", H + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + xe(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + "</sheets></workbook>"),
    f("xl/_rels/workbook.xml.rels", H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    f("xl/styles.xml", H + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
  ];
  sheets.forEach((s, i) => files.push(f("xl/worksheets/sheet" + (i + 1) + ".xml", sheetXml(s))));
  return makeZip(files);
}

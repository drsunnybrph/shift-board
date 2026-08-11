/*
 * parser.js — read a manager's schedule workbook in the browser.
 *
 * The file never leaves the machine. SheetJS runs client-side, the
 * workbook is read from an ArrayBuffer, and nothing is transmitted.
 *
 * Expected shape (this is the common hand-built layout):
 *
 *   row A : anything
 *   row B : day-of-week across the columns   Su M T W Th F Sa ...
 *   row C : day-of-month across the columns  16 17 18 ... 1 2 3 ...
 *   col 1 : names down the rows
 *   cells : position codes, or leave codes
 *
 * A legend anywhere in the sheet giving "CODE  HHMM-HHMM" supplies shift
 * times. A second sheet with position codes down column 1 and Yes/No
 * across supplies required-coverage rules.
 */

const DOW = ['Su','M','Mo','T','Tu','W','We','Th','F','Fr','Sa'];
const NORMALISE_DOW = { Mo:'M', Tu:'T', We:'W', Fr:'F' };

/* ---------- fill colours ----------
 * Hand-built schedules often carry information in cell colour that exists
 * nowhere in the text: most usefully, which days a per diem has declared
 * themselves available. SheetJS only exposes fills when asked (cellStyles),
 * and theme colours arrive as an index plus a tint rather than a hex value,
 * so both have to be resolved against the workbook theme before anything can
 * be compared.
 */
const THEME_ORDER = ['lt1','dk1','lt2','dk2','accent1','accent2','accent3','accent4','accent5','accent6'];

function applyTint(hex, tint) {
  let r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  if (tint > 0) {
    r = Math.round(r + (255-r)*tint); g = Math.round(g + (255-g)*tint); b = Math.round(b + (255-b)*tint);
  } else if (tint < 0) {
    const t = 1 + tint;
    r = Math.round(r*t); g = Math.round(g*t); b = Math.round(b*t);
  }
  const h = n => n.toString(16).padStart(2,'0').toUpperCase();
  return h(r)+h(g)+h(b);
}

/** Normalise any fill on a cell to a six-digit hex string, or null. */
export function fillHex(cell, themeColors) {
  const f = cell && cell.s && cell.s.fgColor;
  if (!f) return null;
  if (f.rgb) {
    const v = String(f.rgb);
    return (v.length === 8 ? v.slice(2) : v).toUpperCase();
  }
  if (typeof f.theme === 'number' && themeColors) {
    const base = themeColors[f.theme];
    if (!base) return null;
    return applyTint(base, f.tint || 0);
  }
  return null;
}

/** Pull the ten theme colours out of the workbook, in openpyxl/SheetJS order. */
function readTheme(workbook) {
  try {
    const raw = workbook.Themes && workbook.Themes.themeElements;
    const scheme = raw && raw.clrScheme;
    if (!scheme) return null;
    const out = [];
    for (const name of THEME_ORDER) {
      const entry = scheme[name] || scheme[name.replace('lt','lt').replace('dk','dk')];
      const hex = entry && (entry.rgb || entry.lastClr);
      out.push(hex ? String(hex).toUpperCase() : null);
    }
    return out.some(Boolean) ? out : null;
  } catch { return null; }
}

/**
 * Colours used to mark availability, rather than to decorate. Weekend shading
 * covers whole columns for everyone including staff with no shifts at all, so
 * a colour is only treated as meaningful when it varies within a row and does
 * not simply track weekends.
 */
function cellText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** Find the row index holding day-of-week labels, and the columns in play. */
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 12); r++) {
    const row = rows[r] || [];
    const cols = [];
    for (let c = 0; c < row.length; c++) {
      const t = cellText(row[c]);
      if (t && DOW.includes(t)) cols.push(c);
    }
    if (cols.length >= 7) return { dowRow: r, cols };
  }
  return null;
}

function readLegend(rows) {
  const times = {};
  const re = /^(\d{3,4})\s*[-\u2013\u2014]\s*(\d{3,4})$/;
  for (const row of rows) {
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const t = cellText(row[c]);
      if (!t) continue;
      const m = t.replace(/\s/g, '').match(re);
      if (!m) continue;
      for (let k = c - 1; k >= Math.max(0, c - 4); k--) {
        const code = cellText(row[k]);
        if (code && code.length <= 5 && !/^\d/.test(code)) {
          const pad = x => x.padStart(4, '0');
          times[code] = `${pad(m[1])}-${pad(m[2])}`;
          break;
        }
      }
    }
  }
  return times;
}

function availabilityColors(rows, dowRow, usedCols, staffRows, fills) {
  const perColour = new Map();
  for (const r of staffRows) {
    for (let k = 0; k < usedCols.length; k++) {
      const hex = fills[`${r}|${k}`];
      if (!hex || hex === 'FFFFFF' || hex === '000000') continue;
      const e = perColour.get(hex) || { cells: 0, byRow: new Map() };
      e.cells++;
      const set = e.byRow.get(r) || new Set();
      set.add(k);
      e.byRow.set(r, set);
      perColour.set(hex, e);
    }
  }

  const out = new Set();
  for (const [hex, e] of perColour) {
    if (e.cells < 8) continue;                    // too rare to be a system
    if (e.byRow.size < 3) continue;               // one or two people isn't a system

    // Decoration paints the same columns for everybody — weekend shading, a
    // closed clinic, a holiday. Availability differs person to person. So the
    // question is how much the marked columns actually vary between rows.
    const signatures = new Set();
    for (const set of e.byRow.values()) {
      signatures.add([...set].sort((a, b) => a - b).join(','));
    }
    const variety = signatures.size / e.byRow.size;
    if (variety < 0.5) continue;                  // most rows identical: decoration

    out.add(hex);
  }
  return out;
}

export function parseWorkbook(workbook, opts = {}) {
  const XLSX = window.XLSX;
  const sheetName = opts.sheet || workbook.SheetNames.find(n => /sched/i.test(n)) || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const themeColors = readTheme(workbook);

  const header = findHeader(rows);
  if (!header) throw new Error('Could not find a row of day-of-week labels (Su M T W Th F Sa). Check the sheet layout.');

  const { dowRow, cols } = header;
  const numRow = rows[dowRow + 1] || [];

  const dates = [];
  const startMonth = opts.startMonth ?? new Date().getMonth() + 1;
  let month = startMonth, prev = 0;
  for (const c of cols) {
    const raw = cellText(numRow[c]);
    const day = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(day)) { dates.push(null); continue; }
    if (day < prev) month = month === 12 ? 1 : month + 1;
    prev = day;
    let dow = cellText(rows[dowRow][c]);
    dow = NORMALISE_DOW[dow] || dow;
    dates.push({ m: month, d: day, dow });
  }
  const keep = dates.map((d, k) => d ? k : -1).filter(k => k >= 0);
  const usedCols = keep.map(k => cols[k]);
  const cleanDates = keep.map(k => dates[k]);

  const legend = readLegend(rows);

  // staff rows: a name in column 1, at least one recognised code across
  const staff = [];
  const codeCount = {};
  const rowIndex = [];
  const fills = {};
  for (let r = dowRow + 2; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = cellText(row[0]);
    if (!name) continue;
    if (/^(staffing|duplicates?|needs?|department|hospital|intern|updated)$/i.test(name)) continue;
    const shifts = {};
    usedCols.forEach((c, k) => {
      const v = cellText(row[c]);
      if (v) { shifts[String(k)] = v; codeCount[v] = (codeCount[v] || 0) + 1; }
      const addr = XLSX.utils.encode_cell({ r, c });
      const hex = fillHex(sheet[addr], themeColors);
      if (hex) fills[`${r}|${k}`] = hex;
    });
    if (Object.keys(shifts).length) { staff.push({ name, shifts }); rowIndex.push(r); }
  }

  // Availability marked by cell colour, where the sheet uses colour that way.
  const availColors = availabilityColors(rows, dowRow, usedCols, rowIndex, fills);
  if (availColors.size) {
    staff.forEach((p, idx) => {
      const r = rowIndex[idx];
      const avail = [];
      for (let k = 0; k < usedCols.length; k++) {
        const hex = fills[`${r}|${k}`];
        if (hex && availColors.has(hex)) avail.push(k);
      }
      if (avail.length) p.available = avail;
    });
  }
  if (!staff.length) throw new Error('No staff rows found. Names should sit in the first column.');

  // positions: codes that appear in the legend, or appear often enough to be real
  const codes = new Set(Object.keys(legend));
  for (const [code, n] of Object.entries(codeCount)) {
    if (n >= 3 && code.length <= 5 && !/^\d+$/.test(code)) codes.add(code);
  }
  const LEAVEISH = /^(x|pto|hol|loa|s|vac|ce|neo|a|m|it|p|off)$/i;
  const positions = [...codes]
    .filter(c => legend[c] || !LEAVEISH.test(c))
    .filter(c => legend[c])
    .map(c => ({ code: c, time: legend[c], label: c }));

  // required coverage from a second sheet, if one looks like it
  const required = {};
  const checkName = workbook.SheetNames.find(n => /check|staffing|coverage/i.test(n) && n !== sheetName);
  if (checkName) {
    const crows = XLSX.utils.sheet_to_json(workbook.Sheets[checkName], { header: 1, raw: true, defval: null });
    const chead = findHeader(crows);
    if (chead) {
      const ccols = keep.map(k => chead.cols[k]).filter(c => c != null);
      for (const row of crows) {
        const code = cellText(row?.[0]);
        if (!code || !codes.has(code)) continue;
        const vals = ccols.map(c => {
          const t = cellText(row[c]);
          if (t == null) return false;
          return /^yes$/i.test(t);
        });
        if (vals.some(Boolean) && !(code in required)) required[code] = vals;
      }
    }
  }

  return {
    meta: { label: sheetName, weekStart: 0, source: 'uploaded',
            availabilityColors: [...availColors] },
    dates: cleanDates,
    positions: positions.sort((a, b) => a.code.localeCompare(b.code)),
    required,
    staff
  };
}

export function readFile(file, opts = {}) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Could not read that file.'));
    fr.onload = () => {
      try {
        const wb = window.XLSX.read(new Uint8Array(fr.result), { type: 'array', cellStyles: true });
        resolve(parseWorkbook(wb, opts));
      } catch (err) { reject(err); }
    };
    fr.readAsArrayBuffer(file);
  });
}

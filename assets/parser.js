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
  const re = /^(\d{3,4})\s*[-–—]\s*(\d{3,4})$/;
  for (const row of rows) {
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const t = cellText(row[c]);
      if (!t) continue;
      const m = t.replace(/\s/g, '').match(re);
      if (!m) continue;
      // walk left for the nearest short token — that's the code
      for (let k = c - 1; k >= Math.max(0, c - 4); k--) {
        const code = cellText(row[k]);
        if (code && code.length <= 5 && !/^\d/.test(code)) {
          const pad = s => s.padStart(4, '0');
          times[code] = `${pad(m[1])}-${pad(m[2])}`;
          break;
        }
      }
    }
  }
  return times;
}

export function parseWorkbook(workbook, opts = {}) {
  const XLSX = window.XLSX;
  const sheetName = opts.sheet || workbook.SheetNames.find(n => /sched/i.test(n)) || workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null });

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
  for (let r = dowRow + 2; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = cellText(row[0]);
    if (!name) continue;
    if (/^(staffing|duplicates?|needs?|department|hospital|intern|updated)$/i.test(name)) continue;
    const shifts = {};
    usedCols.forEach((c, k) => {
      const v = cellText(row[c]);
      if (v) { shifts[String(k)] = v; codeCount[v] = (codeCount[v] || 0) + 1; }
    });
    if (Object.keys(shifts).length) staff.push({ name, shifts });
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
    meta: { label: sheetName, weekStart: 0, source: 'uploaded' },
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
        const wb = window.XLSX.read(new Uint8Array(fr.result), { type: 'array' });
        resolve(parseWorkbook(wb, opts));
      } catch (err) { reject(err); }
    };
    fr.readAsArrayBuffer(file);
  });
}

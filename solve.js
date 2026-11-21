// csv-reader-speed: a fast drop-in CSV reader.
//
// Two-path single-pass scanner: a slice+split fast path for plain physical
// lines, and an indexOf-driven slow path that reproduces the exact broken-CSV
// semantics from the competition prose spec (BOM, stray CR, quoted fields,
// quote junk, unterminated quotes, short/long rows). No dependencies,
// deterministic, nothing cached between cases.
//
// Slow-path shape: quoted fields are the common case in this corpus, so the
// hot paths avoid work per field — junk after a closing quote is decided by
// the single character that follows it, and stray CRs are detected on the
// field-value slice that is built anyway.

const LF = 10;
const CR = 13;
const COMMA = 44;
const QUOTE = 34;
const HAS_BREAK = /[\r\n]/;

export function run(input) {
  const text = input.text;
  const header = input.header === true;
  const N = text.length;

  let pos = 0;
  if (N > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let headerAssigned = false;
  let dataCount = 0;
  let line = 1;

  // ---- current slow-path record state ----
  let curFields = null;
  let curHasContent = false;
  let curStartLine = 1;
  let curRow = null;

  function emitRecord(fields, recStartLine, recRow, isHeader) {
    if (width === -1) width = fields.length;
    if (isHeader) {
      columns = fields;
      headerAssigned = true;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: "short_row", line: recStartLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push("");
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      fields.length = width;
      errors.push({ code: "long_row", line: recStartLine, row: recRow, extra });
    }
    rows.push(fields);
    dataCount++;
  }

  function pushField(value) {
    curFields.push(value);
    curHasContent = true;
  }

  // `val` is a field (or junk) segment known to contain at least one CR.
  // Removes every CR, recording one stray_cr error per dropped CR — except a
  // trailing CR when the segment ends at LF, which is the CRLF half of the
  // line break, not a stray. Returns the cleaned value.
  function stripCRs(val, termKind) {
    let value = val;
    if (termKind === "eol" && value.length > 0 && value.charCodeAt(value.length - 1) === CR) {
      value = value.slice(0, -1);
    }
    let stray = 0;
    let k = -1;
    while ((k = value.indexOf("\r", k + 1)) !== -1) stray++;
    if (stray > 0) {
      value = value.split("\r").join("");
      for (let s = 0; s < stray; s++) {
        errors.push({ code: "stray_cr", line: curStartLine, row: curRow });
      }
    }
    return value;
  }

  // Parse an unquoted field starting at `start`, with `prefix` already
  // collected (used to re-read after an unterminated quote). Returns the
  // terminator: 'comma' | 'eol' | 'eof'. Advances `pos` and `line`.
  function parseUnquoted(start, prefix) {
    const acc = prefix.length ? prefix.join("") : "";
    const nIdx = text.indexOf("\n", start);
    const cIdx = text.indexOf(",", start);
    if (cIdx !== -1 && (nIdx === -1 || cIdx < nIdx)) {
      const val = text.slice(start, cIdx);
      pos = cIdx + 1;
      pushField(val.indexOf("\r") === -1 ? (acc ? acc + val : val) : acc + stripCRs(val, "comma"));
      return "comma";
    }
    if (nIdx !== -1) {
      const val = text.slice(start, nIdx);
      pos = nIdx + 1;
      line++;
      pushField(val.indexOf("\r") === -1 ? (acc ? acc + val : val) : acc + stripCRs(val, "eol"));
      return "eol";
    }
    const val = text.slice(start);
    pos = N;
    pushField(val.indexOf("\r") === -1 ? (acc ? acc + val : val) : acc + stripCRs(val, "eof"));
    return "eof";
  }

  // Scan junk after a closing quote, from `start` to the next comma, line
  // break, or EOF. Lone CRs are stray (dropped, error recorded). Sets `pos`
  // and `line`; returns { junk, term }.
  function scanJunk(start) {
    const nIdx = text.indexOf("\n", start);
    const cIdx = text.indexOf(",", start);
    if (cIdx !== -1 && (nIdx === -1 || cIdx < nIdx)) {
      const seg = text.slice(start, cIdx);
      pos = cIdx + 1;
      return { junk: seg.indexOf("\r") === -1 ? seg : stripCRs(seg, "comma"), term: "comma" };
    }
    if (nIdx !== -1) {
      const seg = text.slice(start, nIdx);
      pos = nIdx + 1;
      line++;
      return { junk: seg.indexOf("\r") === -1 ? seg : stripCRs(seg, "eol"), term: "eol" };
    }
    const seg = text.slice(start);
    pos = N;
    return { junk: seg.indexOf("\r") === -1 ? seg : stripCRs(seg, "eof"), term: "eof" };
  }

  // Parse a quoted field starting at `pos` (text[pos] === '"').
  function parseQuoted() {
    let content = "";
    let i = pos + 1;
    let segStart = i;
    let closedAt = -1;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) {
        // No closing quote anywhere ahead: the opening quote is a literal
        // character and the text after it is read again as unquoted.
        errors.push({ code: "unterminated_quote", line: curStartLine, row: curRow });
        return parseUnquoted(pos + 1, ['"']);
      }
      if (q + 1 < N && text.charCodeAt(q + 1) === QUOTE) {
        content += text.slice(segStart, q);
        content += '"';
        i = q + 2;
        segStart = q + 2;
        continue;
      }
      closedAt = q;
      content += text.slice(segStart, q);
      break;
    }
    // Line breaks inside the quoted content (each LF, CRLF, lone CR counts
    // once); CRs are normalised to LF in the value.
    if (HAS_BREAK.test(content)) {
      if (content.indexOf("\r") !== -1) content = content.replace(/\r\n?/g, "\n");
      let breaks = 0;
      let j = -1;
      while ((j = content.indexOf("\n", j + 1)) !== -1) breaks++;
      line += breaks;
    }
    // Junk after the closing quote: the common cases are decided by the one
    // character that follows it; only real junk needs a scan.
    const after = closedAt + 1;
    let junk = "";
    let term;
    if (after >= N) {
      pos = N;
      term = "eof";
    } else {
      const c = text.charCodeAt(after);
      if (c === COMMA) {
        pos = after + 1;
        term = "comma";
      } else if (c === LF) {
        pos = after + 1;
        line++;
        term = "eol";
      } else if (c === CR) {
        if (after + 1 < N && text.charCodeAt(after + 1) === LF) {
          pos = after + 2;
          line++;
          term = "eol";
        } else {
          errors.push({ code: "stray_cr", line: curStartLine, row: curRow });
          const r = scanJunk(after + 1);
          junk = r.junk;
          term = r.term;
        }
      } else {
        const r = scanJunk(after);
        junk = r.junk;
        term = r.term;
      }
    }
    if (junk.length > 0) {
      errors.push({ code: "quote_junk", line: curStartLine, row: curRow });
    }
    pushField(junk.length > 0 ? content + junk : content);
    return term;
  }

  function parseField() {
    if (text.charCodeAt(pos) === QUOTE) return parseQuoted();
    return parseUnquoted(pos, []);
  }

  // Parse one record with the slow path (current record starts at `pos`).
  function parseSlowRecord() {
    curFields = [];
    curHasContent = false;
    curStartLine = line;
    const isHeader = header && !headerAssigned;
    curRow = isHeader ? null : dataCount;
    let afterComma = false;
    for (;;) {
      if (pos >= N) {
        if (afterComma) curFields.push("");
        break;
      }
      const ch = text.charCodeAt(pos);
      if (ch === LF) {
        if (afterComma) curFields.push("");
        pos++;
        line++;
        break;
      }
      if (ch === CR) {
        if (pos + 1 < N && text.charCodeAt(pos + 1) === LF) {
          if (afterComma) curFields.push("");
          pos += 2;
          line++;
          break;
        }
        errors.push({ code: "stray_cr", line: curStartLine, row: curRow });
        pos++;
        continue;
      }
      if (ch === COMMA) {
        curFields.push("");
        curHasContent = true;
        pos++;
        afterComma = true;
        continue;
      }
      const term = parseField();
      afterComma = term === "comma";
      if (term !== "comma") break;
    }
    if (!curHasContent && curFields.length === 0) return; // no record
    emitRecord(curFields, curStartLine, curRow, isHeader);
  }

  // ---- main loop: fast path per physical line, slow path per record ----
  while (pos < N) {
    const recStartLine = line;
    const isHeader = header && !headerAssigned;
    const recRow = isHeader ? null : dataCount;
    const lf = text.indexOf("\n", pos);
    const segEnd = lf === -1 ? N : lf;
    let contentEnd = segEnd;
    // A trailing CR is the CRLF half only when an LF follows it; a CR at
    // EOF with no LF after it is a lone CR, not a line break.
    if (lf !== -1 && contentEnd > pos && text.charCodeAt(contentEnd - 1) === CR) contentEnd--;
    const seg = text.slice(pos, contentEnd);
    if (seg.indexOf('"') === -1 && seg.indexOf("\r") === -1) {
      if (seg.length !== 0) {
        const fields = seg.split(",");
        emitRecord(fields, recStartLine, recRow, isHeader);
      }
      if (lf === -1) pos = N;
      else { pos = lf + 1; line++; }
      continue;
    }
    parseSlowRecord();
  }

  if (header && !headerAssigned) columns = [];
  return { columns, rows, errors };
}

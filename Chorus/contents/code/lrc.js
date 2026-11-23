// LRC / Lyricsfile parsing + word-sweep helpers
.pragma library

// normalize typographic punctuation in CJK fonts. (basically i was testing the plugin with a zcool font and it had some weird artifacts and this was the fix to that, if youre not using a cjk font then dw bout it :v:)
function normalize(s) {
    if (!s) return s;
    return s
        .replace(/[\u2018\u2019\u02BC\u00B4\u0060]/g, "'")   // ‘ ’ ʼ ´ ` -> '
        .replace(/[\u201C\u201D\u201E]/g, '"')               // “ ” „ -> "
        .replace(/\u2026/g, "...")                            // … -> ...
        .replace(/[\u2013\u2014]/g, "-")                      // – — -> -
        .replace(/\u00A0/g, " ")                              // nbsp -> space
        .replace(/\u3000/g, " ");                             // fullwidth space
}

// Strip outer YAML quotes and unescape the two escapes that matter here.
function unquote(v) {
    v = String(v);
    if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"')
        return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (v.length >= 2 && v.charAt(0) === "'" && v.charAt(v.length - 1) === "'")
        return v.slice(1, -1).replace(/''/g, "'");
    return v;
}

// Detect enhanced-LRC word tags like <00:12.50> inside a line body.
// Returns [{ t, e, text }] when the line carries at least two of them.
function parseEnhancedWords(body) {
    var re = /<(\d+):(\d+(?:\.\d+)?)>/g;
    var marks = [], m, last = 0;
    while ((m = re.exec(body)) !== null) {
        if (m.index > last && marks.length)
            marks[marks.length - 1].text += body.slice(last, m.index);
        marks.push({ t: (parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000,
                     e: 0, text: "" });
        last = re.lastIndex;
    }
    if (marks.length < 2) return null;
    if (last < body.length) marks[marks.length - 1].text += body.slice(last);
    var out = [];
    for (var i = 0; i < marks.length; i++) {
        marks[i].text = normalize(marks[i].text.replace(/\s+$/, " "));
        if (i + 1 < marks.length) marks[i].e = marks[i + 1].t;
        if (marks[i].text.replace(/\s/g, "") !== "") out.push(marks[i]);
    }
    return out.length >= 2 ? out : null;
}

// Parse a plain LRC document into a song object. Lines with >= 2 enhanced
// word tags get word fragments, so enhanced LRC still sweeps word by word.
function parse(lrcText) {
    var lines = [];
    if (!lrcText) return { lines: [], wordSync: false };
    var re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
    var raw = lrcText.split(/\r?\n/);
    for (var i = 0; i < raw.length; i++) {
        var line = raw[i];
        var m, times = [], lastIdx = 0;
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
            times.push((parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000);
            lastIdx = re.lastIndex;
        }
        if (times.length === 0) continue;
        var body = line.slice(lastIdx).trim();
        if (body === "") continue;
        var words = parseEnhancedWords(body);
        var text = words ? joinWords(words) : normalize(body);
        for (var j = 0; j < times.length; j++)
            lines.push({ t: times[j], e: 0, text: text,
                         words: words ? words.slice() : null });
    }
    return finalizeLines(lines);
}

// Lyricsfile YAML (https://lrclib.net/lyricsfile) -> song object with words.
// A tolerant line-based parser for the exact schema LRCLIB serves:
//   lines:
//   - text: "..."
//     start_ms: 410
//     end_ms: 1703
//     words:
//     - text: "('Til "
//       start_ms: 410
//       end_ms: 826
function parseLyricsfile(yaml) {
    if (!yaml) return { lines: [], wordSync: false };
    var raw = String(yaml).replace(/^\uFEFF/, "").split(/\r?\n/);
    var lines = [], cur = null, curWord = null, inWords = false, lineIndent = -1;
    var linesMode = false;
    var reItem = /^(\s*)-\s+text\s*:\s*(.*)$/;
    var reKey = /^(\s*)(start_ms|end_ms|words)\s*:/;
    for (var i = 0; i < raw.length; i++) {
        var line = raw[i];
        if (/^\s*lines\s*:/.test(line)) { linesMode = true; continue; }
        if (/^\s*metadata\s*:/.test(line)) {          // comes before lines:
            cur = null; curWord = null; inWords = false;
            continue;
        }
        if (/^\s*plain\s*:/.test(line)) {             // trailing plain block
            linesMode = false;
            cur = null; curWord = null; inWords = false;
            continue;
        }
        var mItem = reItem.exec(line);
        if (mItem) {
            if (!linesMode) continue;
            var indent = mItem[1].length;
            if (lineIndent < 0) lineIndent = indent;
            if (indent <= lineIndent) {              // a new top-level lyric line
                cur = { t: 0, e: 0, text: unquote(mItem[2]), words: null };
                lines.push(cur);
                curWord = null;
                inWords = false;
            } else if (cur !== null) {               // a word inside cur.words
                curWord = { t: 0, e: 0, text: unquote(mItem[2]) };
                if (!cur.words) cur.words = [];
                cur.words.push(curWord);
                inWords = true;
            }
            continue;
        }
        var mKey = reKey.exec(line);
        if (!mKey) continue;
        var key = mKey[2];
        var val = line.slice(mKey[0].length).trim();
        if (key === "words") { inWords = true; curWord = null; continue; }
        if (key === "start_ms") key = "t";
        else if (key === "end_ms") key = "e";
        var num = parseInt(val, 10);
        if (isNaN(num)) continue;
        if (inWords && curWord) curWord[key] = num;
        else if (cur && !inWords) cur[key] = num;
    }
    return finalizeLines(lines);
}

function joinWords(words) {
    var s = "";
    for (var i = 0; i < words.length; i++) s += words[i].text;
    return normalize(s.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, ""));
}

// Sort lines, drop blanks, fill missing end times from the next entry and
// wrap the result in a song object. words: [{t,e,text}] per line or null.
function finalizeLines(lines) {
    lines.sort(function (a, b) { return a.t - b.t; });
    var clean = [];
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (!ln.text || ln.text === "") continue;
        if (ln.words) {
            var ws = [];
            for (var k = 0; k < ln.words.length; k++) {
                var w = ln.words[k];
                if (w && typeof w.t === "number" && w.t >= 0
                        && w.text !== undefined && w.text !== "")
                    ws.push({ t: w.t, e: w.e || 0, text: String(w.text) });
            }
            // words must cover the line and have real times to sweep
            ln.words = ws.length >= 2 ? ws : null;
        }
        clean.push(ln);
    }
    var wordSync = false;
    for (var j = 0; j < clean.length; j++) {
        var l = clean[j];
        if (!(l.e > l.t))
            l.e = j + 1 < clean.length ? clean[j + 1].t : l.t + 5000;
        if (l.e <= l.t) l.e = l.t + 1000;
        if (l.words) {
            if (!(l.words[l.words.length - 1].e > l.words[l.words.length - 1].t))
                l.words[l.words.length - 1].e = l.e;   // the last word ends with the line
            for (var w2 = 0; w2 < l.words.length; w2++) {
                if (!(l.words[w2].e > l.words[w2].t))
                    l.words[w2].e = (w2 + 1 < l.words.length) ? l.words[w2 + 1].t : l.e;
            }
            wordSync = true;
        }
    }
    return { lines: clean, wordSync: wordSync };
}

// Keep only lines that carry a m:ss.xx] timestamp, drop metadata headers.
function cleanLrc(text) {
    if (!text) return null;
    var lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
    var re = /^\[(\d+):(\d+)(?:\.\d+)?\]/;
    var ok = [];
    for (var i = 0; i < lines.length; i++)
        if (re.test(lines[i])) ok.push(lines[i]);
    return ok.length > 0 ? ok.join("\n") : null;
}

function indexFor(lines, ms) {
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (lines[mid].t <= ms) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans;
}

// ---- word-sweep edge math (adapted from DMS 2.0's Dux Lyrical Engine) ----
// segs: [{ t, e, x0, x1 }] per rendered fragment, x in pixels.
// Where the fill's edge sits: each started cue sweeps across its own span
// over its own time, and without the sweep it fills at once.
function fillEdge(segs, at, sweep, lead) {
    var edge = -lead;
    for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (s.t > at) continue;
        var p = (sweep && s.e > s.t) ? Math.min(1, (at - s.t) / (s.e - s.t)) : 1;
        var from = s.x0 > 0 ? s.x0 : -lead;
        edge = Math.max(edge, from + (s.x1 - from) * p);
    }
    return edge;
}

// The timing edge jumps across a word sung in a few frames and snaps to the
// end of one cut short. Averaging it over a window centred on the clock turns
// every jump into a glide of the window's length that starts half a window
// early, since the cue times are known ahead.
function smoothEdge(segs, at, lead, win) {
    var taps = 7, edge = 0, total = 0;
    for (var i = 0; i < taps; i++) {
        var weight = Math.min(i + 1, taps - i);
        edge += weight * fillEdge(segs, at + win * (i / (taps - 1) - 0.5), true, lead);
        total += weight;
    }
    return edge / total;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function fontSpan(s, css) {
    if (!css || css === "") return s;
    return '<span style="font-family: ' + css + '; white-space: pre">'
           + escapeHtml(s) + '</span>';
}

// ---- DMS 2.0 transcript view model (ported from Dux Modular Shell's
// LyricsModel.js / LyricsController) ----

// DMS LyricLayout.hasWords: whether a line carries real words (notes, dots and
// similar filler glyphs do not count).
var FILLER = /\s|[♩♪♫♬.…·*~()\[\]\-–—]|🎵|🎶|🎼|\uD834[\uDD00-\uDDFF]/g;
function hasWords(text) {
    return String(text || "").replace(FILLER, "") !== "";
}

// DMS LyricsModel.buildItems: a gap longer than breakGap ms before a line
// (also before the first one) becomes an instrumental break item. Times in ms.
function buildItems(lines, breakGap) {
    var items = [], prevEnd = 0;
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (ln.t - prevEnd > breakGap)
            items.push({ kind: "break", line: i, t: prevEnd, e: ln.t });
        items.push({ kind: "line", line: i, t: ln.t, e: ln.e });
        if (isFinite(ln.e)) prevEnd = Math.max(prevEnd, ln.e);
    }
    return items;
}

// DMS LyricsModel.centreItem: the break being played wins over the line before
// it, and the line moving in early wins over the break. followIndex is the
// line the view has moved to ahead of playback.
function centreItem(items, at, followIndex) {
    var centre = 0;
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.t > at && item.line > followIndex) break;
        if (item.t <= at || (item.kind === "line" && item.line <= followIndex))
            centre = i;
    }
    return centre;
}

// DMS LyricsModel.layoutRows, ported over word fragments instead of character
// ranges: wraps a line into rows that fit maxWidth, every fragment keeping its
// own times so the karaoke sweep runs across wrapped rows too. A fragment
// wider than a row breaks between characters, its time split in proportion.
// measure(text) -> advance width in px.
// Returns [{ text, width, segments: [{ t, e, x0, x1 }] }].
function partRows(part, maxWidth, measure) {
    var text = String(part.text || "");
    if (!text) return [];
    var frags = null;
    if (part.words && part.words.length > 1) {
        frags = [];
        for (var i = 0; i < part.words.length; i++) {
            var w = part.words[i];
            if (w && typeof w.t === "number" && w.text)
                frags.push({ t: w.t, e: (typeof w.e === "number" && w.e > w.t) ? w.e : w.t,
                             x: String(w.text) });
        }
        if (frags.length === 0) frags = null;
    }
    if (!frags) {
        // line-level: split into tokens so long lines still wrap; a row's whole
        // fill lights at once when its fragment starts
        frags = [];
        var re = /\S+\s*/g, m;
        while ((m = re.exec(text)) !== null)
            frags.push({ t: part.t, e: part.e, x: m[0] });
        if (frags.length === 0) frags = [{ t: part.t, e: part.e, x: text }];
    }
    // split too-wide fragments between characters, time split in proportion
    var units = [];
    for (var f = 0; f < frags.length; f++) {
        var frag = frags[f];
        var fw = measure(frag.x);
        if (fw <= maxWidth || fw <= 0 || maxWidth <= 0) { units.push(frag); continue; }
        var chars = Array.from(frag.x);
        var total = chars.length;
        var dur = frag.e > frag.t ? frag.e - frag.t : 0;
        for (var c = 0; c < chars.length; ) {
            var chunk = "", cw = 0;
            while (c < chars.length) {
                var nextW = measure(chunk + chars[c]);
                if (chunk !== "" && cw + nextW > maxWidth) break;
                chunk += chars[c];
                cw = nextW;
                c++;
            }
            var from = frag.t + dur * (c - chunk.length) / total;
            var to = frag.t + dur * c / total;
            units.push({ t: from, e: to > from ? to : frag.t, x: chunk });
        }
    }
    var rows = [], row = null, rowW = 0;
    for (var u = 0; u < units.length; u++) {
        var unit = units[u];
        var uw = measure(unit.x);
        if (row !== null && rowW + uw > maxWidth) { rows.push(row); row = null; }
        if (row === null) { row = { text: "", width: 0, segments: [] }; rowW = 0; }
        row.segments.push({ t: unit.t, e: unit.e, x0: rowW, x1: rowW + uw });
        row.text += unit.x;
        rowW += uw;
        row.width = rowW;
    }
    if (row !== null) rows.push(row);
    return rows;
}

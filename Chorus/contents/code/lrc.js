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

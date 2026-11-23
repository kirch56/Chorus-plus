// Lyrics providers, DMS-style (Dux Modular Shell / dux-go lyrics client).
// Providers: Better Lyrics, Unison, LyricsPlus, LRCMux, LiriQo, Lyrica,
// SyncLyrics API, AMLL TTML DB, lrc.red, LyricsDB, Karalyr, KuGou, LRCLIB, YouTube Music.
// Every provider is raced at once and the best answer wins (ctx.enabled may
// still restrict the set, but the widget no longer exposes a picker):
//   ctx = {
//     title, artist, album, durS,      // track metadata, durS = duration in seconds (<= 0 if unknown)
//     enabled,                         // optional array of provider ids to race, priority order;
//                                      // undefined or empty = race every provider
//     later(ms, fn),                   // one-shot callback scheduler (QML Timer)
//     httpGet(url, cb, headers),       // cb(ok, body); optional headers
//     httpPostJson(url, body, cb),     // cb(ok, body)
//     isStale(),                       // true if the current song changed while we were fetching
//     log(msg)
//   }
// A song object: { lines: [{ t, e, text, words: [{t,e,text}] | null }],
//                  wordSync, providerName, durMs?, instrumental? }.
.pragma library
.import "lrc.js" as Lrc

// ---------- shared helpers ----------

function msToLrcTime(ms) {
    ms = Math.max(0, Math.round(ms));
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var c = Math.floor((ms % 1000) / 10);
    return "[" + (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s)
           + "." + (c < 10 ? "0" + c : c) + "]";
}

// TTML times: "HH:MM:SS.mmm", "M:SS.mmm" or "SS.mmm" -> ms
function parseTTMLTime(str) {
    if (!str) return -1;
    var parts = String(str).split(":");
    var sec;
    try {
        if (parts.length === 3)
            sec = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
        else if (parts.length === 2)
            sec = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
        else
            sec = parseFloat(parts[0]);
    } catch (e) { return -1; }
    if (isNaN(sec) || sec < 0) return -1;
    return Math.round(sec * 1000);
}

// Some providers return Apple-style TTML with parallel translation and
// romanization spans (ttm:role="x-translation"/"x-roman"). Those are separate
// lyric tracks, not words from the lead vocal. Exclude them before flattening,
// otherwise every translation is rendered on top of the original line.
function ttmlRole(tag) {
    var m = /(?:[\w.-]+:)?role\s*=\s*["']([^"']+)["']/i.exec(String(tag));
    return m ? m[1].split(/\s+/) : [];
}

function ttmlIsTranslationRole(tag) {
    var roles = ttmlRole(tag);
    for (var i = 0; i < roles.length; i++)
        if (/^(?:x-translation|x-roman|x-transliteration|translation|romanization|transliteration)$/i.test(roles[i]))
            return true;
    return false;
}

function ttmlIsBackgroundRole(tag) {
    var roles = ttmlRole(tag);
    for (var i = 0; i < roles.length; i++)
        if (/^(?:x-bg|x-background|background|background-vocal)$/i.test(roles[i]))
            return true;
    return false;
}

// Unwrap untimed structural spans but preserve timed word spans. Translation
// and romanization subtrees are omitted entirely; their nested timed spans
// must not leak into the lead-vocal word sequence.
function flattenTtmlSpans(s, backgroundLane, rootBackground) {
    var wantBackground = backgroundLane === true;
    var inheritedBackground = rootBackground === true;
    var toks = [], re = /<\/?span\b[^>]*>/g, m, last = 0;
    while ((m = re.exec(s)) !== null) {
        if (m.index > last) toks.push({ t: "x", s: s.slice(last, m.index) });
        toks.push({
            t: m[0].charAt(1) === "/" ? "c" : "o",
            s: m[0],
            timed: /\b(?:begin|end)\s*=/.test(m[0]),
            translation: ttmlIsTranslationRole(m[0]),
            background: ttmlIsBackgroundRole(m[0]),
            selfClosing: /\/\s*>$/.test(m[0])
        });
        last = re.lastIndex;
    }
    if (last < s.length) toks.push({ t: "x", s: s.slice(last) });

    var out = "", stack = [];
    for (var i = 0; i < toks.length; i++) {
        var tk = toks[i];
        if (tk.t === "o") {
            var parent = stack.length > 0 ? stack[stack.length - 1] : null;
            var isBackground = (parent ? parent.background : inheritedBackground) || tk.background;
            var isTranslation = (parent ? parent.translation : false) || tk.translation;
            var excluded = isTranslation || isBackground !== wantBackground;
            if (!tk.selfClosing)
                stack.push({ excluded: excluded, timed: tk.timed && !excluded,
                             background: isBackground, translation: isTranslation });
            if (!excluded && tk.timed) out += tk.s;
        } else if (tk.t === "c") {
            var frame = stack.pop();
            if (frame && !frame.excluded && frame.timed) out += tk.s;
        } else {
            var active = stack.length > 0 ? stack[stack.length - 1] : null;
            var skipText = active
                    ? active.translation || active.background !== wantBackground
                    : inheritedBackground !== wantBackground;
            if (!skipText) out += tk.s;
        }
    }
    return out;
}

// TTML karaoke may store consecutive word spans with no literal whitespace
// between them. Preserve explicit spaces; otherwise reconstruct normal English
// word boundaries without splitting contractions or punctuation.
function ttmlNeedsWordSpace(previous, next) {
    if (!previous || !next || /\s$/.test(previous) || /^\s/.test(next)) return false;
    if (/['’‘-]$/.test(previous) || /^['’‘-]/.test(next)) return false;
    var left = previous.charAt(previous.length - 1);
    var right = next.charAt(0);
    return /[A-Za-z0-9,.;:!?…)\]]/.test(left)
        && /[A-Za-z0-9("'“‘\[]/.test(right)
        && (/[A-Za-z0-9]/.test(left) || /[,.;:!?…)\]]/.test(left));
}

function ttmlSpaceWordTokens(words) {
    for (var i = 1; i < words.length; i++)
        if (ttmlNeedsWordSpace(words[i - 1].text, words[i].text))
            words[i - 1].text += " ";
}

function ttmlJoinWordText(words) {
    var out = "";
    for (var i = 0; i < words.length; i++)
        out += String(words[i].text || "");
    return out.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

// Word-level spans inside a TTML <p>. Explicit whitespace is retained;
// missing boundaries between timed English words are reconstructed. Translation,
// romanization and background spans have already been filtered.
function parseTTMLWords(inner, preserveSourceSpacing, backgroundLane, rootBackground, allowSingle) {
    var flat = flattenTtmlSpans(String(inner), backgroundLane, rootBackground);
    var re = /<span\b([^>]*)>([\s\S]*?)<\/span>([\s\S]*?)(?=<span\b|$)/g;
    var words = [], m;
    while ((m = re.exec(flat)) !== null) {
        var bt = /\bbegin\s*=\s*["']([^"']+)["']/.exec(m[1]);
        var et = /\bend\s*=\s*["']([^"']+)["']/.exec(m[1]);
        var t = bt ? parseTTMLTime(bt[1]) : -1;
        var e = et ? parseTTMLTime(et[1]) : 0;
        var text = m[2].replace(/<[^>]*>/g, "")
                   .replace(/\{agent:[^}]*\}/gi, "").replace(/\{bg\}/gi, "");
        var gap = m[3].replace(/<[^>]*>/g, "");
        if (t < 0 || text.replace(/\s/g, "") === "") continue;
        if (gap !== "" && !/\S/.test(gap)) text += gap;
        words.push({ t: t, e: e > t ? e : 0, text: text });
    }
    for (var i = 1; i < words.length; i++)
        if (/^[(（]/.test(words[i].text) && !/\s$/.test(words[i - 1].text))
            words[i - 1].text += " ";
    if (!preserveSourceSpacing) ttmlSpaceWordTokens(words);
    return words.length >= (allowSingle === true ? 1 : 2) ? words : null;
}

// TTML -> song object. Regex-based because the QML JS engine has no DOMParser.
// Apple Music style TTML (itunes:timing="Word") carries one <span> per word;
// when a line has at least two timed spans it becomes a word-level line.
function ttmlToSong(ttml, preserveSourceSpacing) {
    if (!ttml || String(ttml).indexOf("<") === -1) return null;
    var out = [], standaloneBackgrounds = [];
    var re = /<p\b[^>]*?begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
    var m;
    while ((m = re.exec(String(ttml))) !== null) {
        var open = m[0].slice(0, m[0].indexOf(">"));
        if (ttmlIsTranslationRole(open)) continue;
        var paragraphBackground = ttmlIsBackgroundRole(open);
        var t = parseTTMLTime(m[1]);
        var endM = /\bend\s*=\s*["']([^"']+)["']/.exec(open);
        var e = endM ? parseTTMLTime(endM[1]) : 0;

        // Backing vocals may be x-bg spans inside a lead paragraph, or
        // a separate paragraph whose role is x-bg.
        var words = paragraphBackground ? null
                : parseTTMLWords(m[2], preserveSourceSpacing, false, false);
        var leadInner = paragraphBackground ? ""
                : flattenTtmlSpans(m[2], false, false);
        var text = paragraphBackground ? ""
                : words ? ttmlJoinWordText(words)
                : leadInner.replace(/<[^>]*>/g, "")
                    .replace(/\{agent:[^}]*\}/gi, "").replace(/\{bg\}/gi, "")
                    .replace(/([^\s(（])\(/g, "$1 (").replace(/\s+/g, " ").trim();

        var bgWords = parseTTMLWords(m[2], preserveSourceSpacing, true,
                                     paragraphBackground, true);
        var bgInner = flattenTtmlSpans(m[2], true, paragraphBackground);
        var bgText = bgWords ? ttmlJoinWordText(bgWords)
                : bgInner.replace(/<[^>]*>/g, "")
                    .replace(/\{agent:[^}]*\}/gi, "").replace(/\{bg\}/gi, "")
                    .replace(/\s+/g, " ").trim();
        var bg = null;
        if (bgText !== "") {
            var bgStart = bgWords && bgWords.length ? bgWords[0].t : t;
            var bgEnd = e;
            for (var bi = 0; bgWords && bi < bgWords.length; bi++)
                if (bgWords[bi].e > bgEnd) bgEnd = bgWords[bi].e;
            bg = { t: bgStart >= 0 ? bgStart : t, e: bgEnd, text: bgText, words: bgWords };
        }

        if (t < 0) continue;
        if (paragraphBackground) {
            if (bgText !== "") standaloneBackgrounds.push(bg);
            continue;
        }
        if (text === "") continue;
        out.push({ t: t, e: e > t ? e : 0, text: text, words: words,
                   backgrounds: bg ? [bg] : [] });
    }

    // Pair separate x-bg paragraphs with the closest overlapping lead line.
    for (var b = 0; b < standaloneBackgrounds.length; b++) {
        var part = standaloneBackgrounds[b], best = null, bestDistance = Number.POSITIVE_INFINITY;
        var bestScore = -Number.POSITIVE_INFINITY;
        for (var li = 0; li < out.length; li++) {
            var lead = out[li];
            var leadEnd = lead.e > lead.t ? lead.e : lead.t + 5000;
            var partEnd = part.e > part.t ? part.e : part.t + 5000;
            var overlap = Math.min(leadEnd, partEnd) - Math.max(lead.t, part.t);
            var distance = Math.min(Math.abs(part.t - leadEnd), Math.abs(lead.t - partEnd));
            var score = overlap > 0 ? overlap : -distance;
            if (score > bestScore) {
                bestScore = score;
                bestDistance = overlap > 0 ? 0 : distance;
                best = lead;
            }
        }
        if (best && bestDistance <= 2500) {
            if (!best.backgrounds) best.backgrounds = [];
            best.backgrounds.push(part);
        }
    }

    if (out.length === 0) return null;
    var song = Lrc.finalizeLines(out);
    var backgroundWordSync = false;
    for (var li2 = 0; li2 < song.lines.length; li2++) {
        var leadLine = song.lines[li2];
        var backgrounds = leadLine.backgrounds || [];
        for (var bi2 = 0; bi2 < backgrounds.length; bi2++) {
            var bgPart = backgrounds[bi2];
            var normalized = Lrc.finalizeLines([{
                t: bgPart.t, e: bgPart.e, text: bgPart.text, words: bgPart.words
            }]);
            if (normalized.lines.length > 0) {
                backgrounds[bi2] = normalized.lines[0];
                if (normalized.wordSync) backgroundWordSync = true;
            }
        }
        leadLine.backgrounds = backgrounds;
        for (var bi3 = 0; bi3 < backgrounds.length; bi3++)
            if (backgrounds[bi3].e > leadLine.e) leadLine.e = backgrounds[bi3].e;
    }
    if (backgroundWordSync) song.wordSync = true;
    return song;
}

// YouTube timedtext json3 -> song object (line-level only).
function json3ToSong(jsonText) {
    var data;
    try { data = JSON.parse(jsonText); } catch (e) { return null; }
    if (!data || !data.events) return null;
    var out = [];
    for (var i = 0; i < data.events.length; i++) {
        var ev = data.events[i];
        if (!ev || !ev.segs || ev.tStartMs === undefined) continue;
        var text = "";
        for (var j = 0; j < ev.segs.length; j++)
            if (ev.segs[j] && typeof ev.segs[j].utf8 === "string")
                text += ev.segs[j].utf8;
        text = text.replace(/\s+/g, " ").trim();
        if (text === "") continue;
        var e = ev.tStartMs + (typeof ev.dDurationMs === "number" ? ev.dDurationMs : 0);
        out.push({ t: ev.tStartMs, e: e > ev.tStartMs ? e : 0, text: text, words: null });
    }
    if (out.length === 0) return null;
    return Lrc.finalizeLines(out);
}

// Plain LRC text -> song object (line-level, or word-level for enhanced LRC).
function lrcTextToSong(text) {
    var cleaned = Lrc.cleanLrc(text);
    if (!cleaned) return null;
    var song = Lrc.parse(cleaned);
    return song && song.lines.length > 0 ? song : null;
}

// base64 (UTF-8 payload) -> string. Qt.atob gives latin1, so decode UTF-8 manually.
function b64ToUtf8(b64) {
    var bin;
    try { bin = Qt.atob(String(b64).replace(/\s+/g, "")); } catch (e) { return null; }
    if (!bin) return null;
    var out = "";
    try {
        for (var i = 0; i < bin.length; ) {
            var c = bin.charCodeAt(i);
            if (c < 0x80) {
                out += String.fromCharCode(c);
                i += 1;
            } else if (c < 0xE0) {
                out += String.fromCharCode(((c & 0x1F) << 6) | (bin.charCodeAt(i + 1) & 0x3F));
                i += 2;
            } else if (c < 0xF0) {
                out += String.fromCharCode(((c & 0x0F) << 12)
                        | ((bin.charCodeAt(i + 1) & 0x3F) << 6)
                        | (bin.charCodeAt(i + 2) & 0x3F));
                i += 3;
            } else {
                var cp = ((c & 0x07) << 18) | ((bin.charCodeAt(i + 1) & 0x3F) << 12)
                        | ((bin.charCodeAt(i + 2) & 0x3F) << 6)
                        | (bin.charCodeAt(i + 3) & 0x3F);
                cp -= 0x10000;
                out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
                i += 4;
            }
        }
    } catch (e) {
        return bin; // not valid UTF-8, fall back to latin1
    }
    return out;
}

// Unwrap a lyrics payload that may arrive either as raw TTML or as a JSON
// envelope { "ttml": "..." } (what api.betterlyrics.org actually returns;
// the TTML inside is unescaped by JSON.parse). Returns the TTML string or
// null when the payload is neither.
function unwrapTtml(resp) {
    if (!resp) return null;
    var s = String(resp).replace(/^\uFEFF/, "").trim();
    if (s.charAt(0) === "{") {
        try {
            var j = JSON.parse(s);
            if (j && typeof j.ttml === "string" && j.ttml !== "") return j.ttml;
            if (j && typeof j.lyrics === "string" && j.lyrics !== "") return j.lyrics;
        } catch (e) {}
        return null;
    }
    return s.indexOf("<") !== -1 ? s : null;
}

// ---------- Better Lyrics ----------
// 1. GET https://api.betterlyrics.org/getLyrics?s={song}&a={artist}&al={album}&d={duration}
//    Returns { ttml: "<tt ...>...</tt>" } (Apple Music TTML, itunes:timing="Word"
//    when word timings exist). Cache hits need no key; cache misses return 401
//    (no keys are being issued), which we treat as "no lyrics here".
// 2. Fallback: GET /kugou/getLyrics?s={song}&a={artist}&d={duration}
//    Returns { lyrics: "...LRC..." } and never needs a key.

function fetchBetterLyrics(ctx, cb) {
    var url = "https://api.betterlyrics.org/getLyrics?s=" + encodeURIComponent(ctx.title)
            + "&a=" + encodeURIComponent(ctx.artist)
            + "&al=" + encodeURIComponent(ctx.album || "")
            + "&d=" + (ctx.durS > 0 ? ctx.durS : 0);
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var song = ok ? ttmlToSong(unwrapTtml(resp)) : null;
        if (song) {
            var info = providerTrackInfo(safeJson(resp));
            if (info.title) song.matchTitle = info.title;
            if (info.artist) song.matchArtist = info.artist;
            if (info.duration > 0) song.durMs = Math.round(info.duration * 1000);
            cb(song);
            return;
        }
        var url2 = "https://api.betterlyrics.org/kugou/getLyrics?s=" + encodeURIComponent(ctx.title)
                 + "&a=" + encodeURIComponent(ctx.artist)
                 + "&d=" + (ctx.durS > 0 ? ctx.durS : 0);
        ctx.httpGet(url2, function (ok2, resp2) {
            if (ctx.isStale()) return;
            if (!ok2 || !resp2) { cb(null); return; }
            var body;
            try { body = JSON.parse(resp2); } catch (e) { cb(null); return; }
            var fallbackSong = body && typeof body.lyrics === "string"
                    ? lrcTextToSong(body.lyrics) : null;
            if (fallbackSong) {
                var info = providerTrackInfo(body);
                if (info.title) fallbackSong.matchTitle = info.title;
                if (info.artist) fallbackSong.matchArtist = info.artist;
                if (info.duration > 0) fallbackSong.durMs = Math.round(info.duration * 1000);
            }
            cb(fallbackSong);
        });
    });
}

// ---------- Unison ----------
// GET https://unison.betterlyrics.org/lyrics?song={song}&artist={artist}&album={album}&duration={seconds}
// Returns { success, data: { lyrics, format: "ttml"|"lrc"|"plain", submitter, ... } }.

function fetchUnison(ctx, cb) {
    var url = "https://unison.betterlyrics.org/lyrics?song=" + encodeURIComponent(ctx.title)
            + "&artist=" + encodeURIComponent(ctx.artist);
    if (ctx.album) url += "&album=" + encodeURIComponent(ctx.album);
    if (ctx.durS > 0) url += "&duration=" + ctx.durS;
    ctx.httpGet(url, function (ok, resp) {
        if (!ok || !resp) { cb(null); return; }
        var body;
        try { body = JSON.parse(resp); } catch (e) { cb(null); return; }
        if (!body || body.success !== true || !body.data
                || typeof body.data.lyrics !== "string") {
            cb(null);
            return;
        }
        var fmt = body.data.format;
        var song = null;
        if (fmt === "lrc") song = lrcTextToSong(body.data.lyrics);
        else if (fmt === "ttml") song = ttmlToSong(body.data.lyrics);
        // "plain" is not synced; skip it.
        if (song) {
            var unisonInfo = providerTrackInfo(body.data);
            if (unisonInfo.title) song.matchTitle = unisonInfo.title;
            if (unisonInfo.artist) song.matchArtist = unisonInfo.artist;
            if (unisonInfo.duration > 0) song.durMs = Math.round(unisonInfo.duration * 1000);
            // Unison requires crediting the submitter of the lyrics.
            var who = "";
            try {
                if (body.data.submitter && body.data.submitter.displayName)
                    who = body.data.submitter.displayName;
            } catch (e) {}
            ctx.log("lyrics: Unison match"
                    + (who !== "" ? " submitted by " + who : "")
                    + " (credit: https://unison.betterlyrics.org)");
        }
        cb(song);
    });
}

// ---------- LyricsPlus ----------
// GET {base}/v2/lyrics/get?title=&artist=&album=&duration=&source=...
// Returns { type, lyrics: [{ time (ms), duration (ms), text, syllabus?, ... }], cached }.
// When the matched source has word timings (type "Word", e.g. Musixmatch word
// sync or Apple), every line carries a syllabus array with per-word/per-syllable
// times; those become the word fragments.

var LYRICSPLUS_BASES = [
    "https://lyricsplus.binimum.org",
    "https://lyricsplus.prjktla.my.id",
    "https://lyricsplus-seven.vercel.app"
];

function lyricsPlusToSong(body) {
    if (!body || !body.lyrics || !body.lyrics.length) return null;
    var out = [];
    for (var i = 0; i < body.lyrics.length; i++) {
        var ln = body.lyrics[i];
        if (!ln || typeof ln.time !== "number") continue;
        var text = (typeof ln.text === "string") ? ln.text.replace(/\s+/g, " ").trim() : "";
        if (text === "") continue;
        var words = null;
        if (ln.syllabus && ln.syllabus.length >= 2) {
            words = [];
            for (var j = 0; j < ln.syllabus.length; j++) {
                var syl = ln.syllabus[j];
                if (!syl || typeof syl.time !== "number"
                        || typeof syl.text !== "string" || syl.text === "") continue;
                words.push({ t: syl.time,
                             e: syl.time + (typeof syl.duration === "number" ? syl.duration : 0),
                             text: syl.text });
            }
            if (words.length < 2) words = null;
        }
        var e = ln.time + (typeof ln.duration === "number" ? ln.duration : 0);
        out.push({ t: ln.time, e: e > ln.time ? e : 0, text: text, words: words });
    }
    if (out.length === 0) return null;
    return Lrc.finalizeLines(out);
}

function fetchLyricsPlus(ctx, cb) {
    var qs = "?title=" + encodeURIComponent(ctx.title)
           + "&artist=" + encodeURIComponent(ctx.artist);
    if (ctx.album) qs += "&album=" + encodeURIComponent(ctx.album);
    if (ctx.durS > 0) qs += "&duration=" + ctx.durS;
    qs += "&source=apple,lyricsplus,qq,musixmatch,musixmatch-word";

    function tryBase(i) {
        if (ctx.isStale()) return;
        if (i >= LYRICSPLUS_BASES.length) { cb(null); return; }
        ctx.httpGet(LYRICSPLUS_BASES[i] + "/v2/lyrics/get" + qs, function (ok, resp) {
            if (ok && resp) {
                var body;
                try { body = JSON.parse(resp); } catch (e) {}
                var song = lyricsPlusToSong(body);
                if (song) {
                    var info = providerTrackInfo(body);
                    if (info.title) song.matchTitle = info.title;
                    if (info.artist) song.matchArtist = info.artist;
                    if (info.duration > 0) song.durMs = Math.round(info.duration * 1000);
                    cb(song);
                    return;
                }
            }
            tryBase(i + 1);
        });
    }
    tryBase(0);
}

// ---------- KuGou ----------
// 1. GET https://mobileservice.kugou.com/api/v3/search/song?version=9108&plat=0&pagesize=8&showtype=0&keyword={kw}
//    -> data.info[] = [{ hash, duration }]
// 2. GET https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash={hash}
//    -> candidates[0] = { id, accesskey }   (duration must match within 8 s)
//    Fallback: ...&duration={ms}&keyword={kw}
// 3. GET https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1&id={id}&accesskey={key}
//    -> content = base64-encoded LRC
// Logic adapted from ViMusic / ArchiveTune. KuGou serves line-level LRC only.

var KUGOU_DURATION_TOLERANCE = 8;

// KuGou files carry credit lines ("作词：...", "Composer：..."); ViMusic-style
// head/tail cut removes the runs of them around the actual lyric lines.
function kugouStripCredits(text) {
    var lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
    var accepted = [], banned = /.+\].+[:：].+/;
    for (var i = 0; i < lines.length; i++)
        if (/^\[\d\d:\d\d\.\d{2,3}\]/.test(lines[i])) accepted.push(lines[i]);
    if (accepted.length === 0) return null;
    var headCut = 0;
    var headLimit = Math.min(30, accepted.length - 1);
    for (var j = headLimit; j >= 0; j--)
        if (banned.test(accepted[j])) { headCut = j + 1; break; }
    var tailCut = 0;
    var tailLimit = Math.min(accepted.length - 30, accepted.length - 1);
    for (var k = tailLimit; k >= 0; k--)
        if (banned.test(accepted[accepted.length - 1 - k])) { tailCut = k + 1; break; }
    var out = accepted.slice(headCut, accepted.length - tailCut);
    return out.length > 0 ? out.join("\n") : null;
}

function kugouCleanKeyword(s) {
    return String(s || "")
        .replace(/\([^)]*\)|（[^）]*）|「[^」]*」|『[^』]*』|〈[^〉]*〉|＜[^＞]*＞|《[^》]*》/g, "")
        .replace(/\s+/g, " ").trim();
}

function kugouKeyword(ctx) {
    var title = kugouCleanKeyword(ctx.title);
    var artist = kugouCleanKeyword(ctx.artist).replace(/,\s*|\s*&\s*|和/g, "、").replace(/\./g, "");
    return title + " - " + artist;
}

function kugouDownload(ctx, id, accesskey, cb) {
    var url = "https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1"
            + "&id=" + encodeURIComponent(id)
            + "&accesskey=" + encodeURIComponent(accesskey);
    ctx.httpGet(url, function (ok, resp) {
        if (!ok || !resp) { cb(null); return; }
        var body;
        try { body = JSON.parse(resp); } catch (e) { cb(null); return; }
        if (!body || !body.content) { cb(null); return; }
        var text = b64ToUtf8(body.content);
        cb(text ? lrcTextToSong(kugouStripCredits(text) || "") : null);
    });
}

function kugouFirstCandidate(ctx, hash, cb) {
    var url = "https://lyrics.kugou.com/search?ver=1&man=yes&client=pc"
            + "&hash=" + encodeURIComponent(hash);
    ctx.httpGet(url, function (ok, resp) {
        if (!ok || !resp) { cb(null); return; }
        var body;
        try { body = JSON.parse(resp); } catch (e) { cb(null); return; }
        var c = body && body.candidates && body.candidates.length ? body.candidates[0] : null;
        cb(c && c.id !== undefined && c.accesskey ? c : null);
    });
}

function kugouTrySongs(ctx, info, i, cb) {
    if (ctx.isStale()) return;
    if (i >= info.length) { kugouKeywordSearch(ctx, cb); return; }
    var durOk = ctx.durS <= 0
            || Math.abs((info[i].duration || 0) - ctx.durS) <= KUGOU_DURATION_TOLERANCE;
    if (!info[i].hash || !durOk) { kugouTrySongs(ctx, info, i + 1, cb); return; }
    kugouFirstCandidate(ctx, info[i].hash, function (cand) {
        if (ctx.isStale()) return;
        if (!cand) { kugouTrySongs(ctx, info, i + 1, cb); return; }
        kugouDownload(ctx, cand.id, cand.accesskey, function (song) {
            if (ctx.isStale()) return;
            if (song) {
                song.durMs = typeof info[i].duration === "number" && info[i].duration > 0
                        ? Math.round(info[i].duration * 1000) : 0;
                if (typeof info[i].songname === "string") song.matchTitle = info[i].songname;
                if (typeof info[i].singername === "string") song.matchArtist = info[i].singername;
                cb(song);
                return;
            }
            kugouTrySongs(ctx, info, i + 1, cb);
        });
    });
}

function kugouKeywordSearch(ctx, cb) {
    if (ctx.durS <= 0) { cb(null); return; }
    var url = "https://lyrics.kugou.com/search?ver=1&man=yes&client=pc"
            + "&duration=" + (ctx.durS * 1000)
            + "&keyword=" + encodeURIComponent(kugouKeyword(ctx));
    ctx.httpGet(url, function (ok, resp) {
        if (!ok || !resp) { cb(null); return; }
        var body;
        try { body = JSON.parse(resp); } catch (e) { cb(null); return; }
        var c = body && body.candidates && body.candidates.length ? body.candidates[0] : null;
        if (!c || c.id === undefined || !c.accesskey) { cb(null); return; }
        kugouDownload(ctx, c.id, c.accesskey, cb);
    });
}

function fetchKugou(ctx, cb) {
    var url = "https://mobileservice.kugou.com/api/v3/search/song?version=9108&plat=0"
            + "&pagesize=8&showtype=0&keyword=" + encodeURIComponent(kugouKeyword(ctx));
    ctx.httpGet(url, function (ok, resp) {
        if (!ok || !resp) { cb(null); return; }
        var body;
        try { body = JSON.parse(resp); } catch (e) { cb(null); return; }
        var info = body && body.data && body.data.info ? body.data.info : [];
        kugouTrySongs(ctx, info, 0, cb);
    });
}

// ---------- YouTube Music ----------
// Synced captions from YouTube. Nothing here is an official public API, so it
// is best-effort: YouTube gates some networks (datacenter IPs) entirely, and
// captions are line-level only (no word timings).
// 1. InnerTube search on music.youtube.com (WEB_REMIX) -> first videoId.
// 2. InnerTube player, ANDROID first (still returns ungated caption baseUrls
//    on most networks), then WEB_REMIX, then the watch page.
// 3. timedtext fmt=json3 -> song.

var YT_WEB_REMIX_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
var YT_ANDROID_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w";

function ytFindVideoId(obj, depth) {
    if (!obj || depth > 12) return null;
    if (typeof obj !== "object") return null;
    if (obj.videoId && typeof obj.videoId === "string") return obj.videoId;
    if (obj.watchEndpoint && obj.watchEndpoint.videoId) return obj.watchEndpoint.videoId;
    if (obj.playlistItemData && obj.playlistItemData.videoId) return obj.playlistItemData.videoId;
    for (var k in obj) {
        var v = obj[k];
        if (v && typeof v === "object") {
            var r = ytFindVideoId(v, depth + 1);
            if (r) return r;
        }
    }
    return null;
}

function fetchYoutubeMusic(ctx, cb) {
    var searchBody = JSON.stringify({
        context: { client: { clientName: "WEB_REMIX", clientVersion: "1.20240403.01.00",
                             hl: "en", gl: "US" } },
        query: ctx.title + " " + ctx.artist
    });
    ctx.httpPostJson("https://music.youtube.com/youtubei/v1/search?key=" + YT_WEB_REMIX_KEY
                     + "&prettyPrint=false", searchBody, function (ok, resp) {
        if (ctx.isStale()) return;
        var videoId = null;
        if (ok && resp) {
            try { videoId = ytFindVideoId(JSON.parse(resp), 0); } catch (e) {}
        }
        if (!videoId) { cb(null); return; }
        ytFetchCaptions(ctx, videoId, cb);
    });
}

function ytPlayerCaptions(ctx, videoId, url, body, cb) {
    ctx.httpPostJson(url, body, function (ok, resp) {
        if (ctx.isStale()) return;
        var tracks = null;
        if (ok && resp) {
            try {
                var data = JSON.parse(resp);
                tracks = data && data.captions
                         && data.captions.playerCaptionsTracklistRenderer
                         && data.captions.playerCaptionsTracklistRenderer.captionTracks;
            } catch (e) {}
        }
        if (!tracks || !tracks.length) { cb(null); return; }
        // Prefer a human-made caption track over auto-generated (kind === "asr").
        var track = null;
        for (var i = 0; i < tracks.length; i++)
            if (tracks[i] && tracks[i].baseUrl && !tracks[i].kind) { track = tracks[i]; break; }
        if (!track) track = tracks[0];
        if (!track || !track.baseUrl) { cb(null); return; }
        ctx.httpGet(track.baseUrl + "&fmt=json3", function (ok2, resp2) {
            if (ctx.isStale()) return;
            if (!ok2 || !resp2) { cb(null); return; }
            cb(json3ToSong(resp2));
        });
    });
}

function ytFetchCaptions(ctx, videoId, cb) {
    // 1) ANDROID player
    ytPlayerCaptions(ctx, videoId,
        "https://www.youtube.com/youtubei/v1/player?key=" + YT_ANDROID_KEY + "&prettyPrint=false",
        JSON.stringify({
            context: { client: { clientName: "ANDROID", clientVersion: "19.09.37",
                                 androidSdkVersion: 30, hl: "en" } },
            videoId: videoId
        }),
        function (song) {
            if (ctx.isStale() || song) { cb(song); return; }
            // 2) WEB_REMIX player on the music host
            ytPlayerCaptions(ctx, videoId,
                "https://music.youtube.com/youtubei/v1/player?key=" + YT_WEB_REMIX_KEY + "&prettyPrint=false",
                JSON.stringify({
                    context: { client: { clientName: "WEB_REMIX", clientVersion: "1.20240403.01.00",
                                         hl: "en", gl: "US" } },
                    videoId: videoId
                }),
                cb);
        });
    // 3) Watch page fallback is not available in QML (no cookies/redirect
    //    handling in XHR), the two players above cover the realistic cases.
}

// ---------- LRCLIB ----------
// DMS provider tier: GET /api/get (exact signature match), then
// /api/search (best record). Records with hasWordSync carry the lyricsfile
// YAML with word timings; plain syncedLyrics are line-level LRC.
// An instrumental answer comes back as an empty instrumental song.

function lrclibRecordToSong(rec) {
    if (!rec) return null;
    if (rec.instrumental === true)
        return { lines: [], wordSync: false, instrumental: true,
                 providerName: "LRCLIB", durMs: (typeof rec.duration === "number" ? rec.duration * 1000 : 0) };
    var song = null;
    if (rec.hasWordSync && rec.lyricsfile) {
        song = Lrc.parseLyricsfile(rec.lyricsfile);
    }
    if ((!song || song.lines.length === 0) && rec.syncedLyrics) {
        song = Lrc.parse(rec.syncedLyrics);
    }
    if (!song || song.lines.length === 0) return null;
    song.providerName = "LRCLIB";
    song.durMs = (typeof rec.duration === "number" && rec.duration > 0) ? Math.round(rec.duration * 1000) : 0;
    if (typeof rec.trackName === "string") song.matchTitle = rec.trackName;
    if (typeof rec.artistName === "string") song.matchArtist = rec.artistName;
    return song;
}

function fetchLrclib(ctx, cb) {
    var durS = ctx.durS > 0 ? ctx.durS : 0;
    var url = "https://lrclib.net/api/get?track_name=" + encodeURIComponent(ctx.title)
            + "&artist_name=" + encodeURIComponent(ctx.artist);
    if (ctx.album) url += "&album_name=" + encodeURIComponent(ctx.album);
    if (durS > 0) url += "&duration=" + durS;
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var rec = null;
        if (ok && resp) {
            try { rec = JSON.parse(resp); } catch (e) {}
        }
        if (rec && (rec.instrumental === true || rec.hasWordSync || rec.syncedLyrics)) {
            cb(lrclibRecordToSong(rec));
            return;
        }
        // A plain or missing answer gets a title search; the same song is
        // published under many signatures, so the exact call often misses.
        var url2 = "https://lrclib.net/api/search?track_name=" + encodeURIComponent(ctx.title)
                 + "&artist_name=" + encodeURIComponent(ctx.artist);
        ctx.httpGet(url2, function (ok2, resp2) {
            if (ctx.isStale()) return;
            var best = null;
            if (ok2 && resp2) {
                try {
                    var arr = JSON.parse(resp2);
                    // Prefer the closest recording, not merely the first
                    // word-synced result. Album editions, remixes and radio
                    // edits often share a base title but have different lengths.
                    var bestScore = -1;
                    for (var i = 0; i < arr.length; i++) {
                        var candidate = arr[i];
                        if (!candidate || !(candidate.instrumental === true
                                || candidate.hasWordSync || candidate.syncedLyrics)) continue;
                        var candidateSong = lrclibRecordToSong(candidate);
                        if (!candidateSong || dmsMetadataProblem(ctx, candidateSong) !== "") continue;
                        var score = (candidateSong.wordSync ? 8 : 0)
                                  + (candidateSong.matchTitle ? 4 : 0)
                                  + (candidateSong.matchArtist ? 2 : 0)
                                  + (candidateSong.durMs > 0 ? 2 : 0);
                        if (score > bestScore) {
                            best = candidate;
                            bestScore = score;
                        }
                    }
                } catch (e) {}
            }
            cb(best ? lrclibRecordToSong(best) : null);
        });
    });
}

// ---------- additional word-level providers ----------

// The providers below intentionally share the widget's existing normalization
// model. All times in this file are milliseconds unless noted otherwise.

// Extract only metadata actually returned by a lyrics catalogue. Never
// substitute the player's duration for a missing catalogue duration: doing
// that makes an original recording look like a verified remix match.
function providerTrackInfo(body) {
    var root = body || {};
    var track = root.track && typeof root.track === "object" ? root.track : {};
    var data = root.data && typeof root.data === "object" ? root.data : {};
    var nested = data.track && typeof data.track === "object" ? data.track : {};
    function pickString(objects, keys) {
        for (var i = 0; i < objects.length; i++)
            for (var j = 0; j < keys.length; j++) {
                var value = objects[i] && objects[i][keys[j]];
                if (typeof value === "string" && value.trim() !== "") return value.trim();
            }
        return "";
    }
    function pickNumber(objects, keys) {
        for (var i = 0; i < objects.length; i++)
            for (var j = 0; j < keys.length; j++) {
                var value = objects[i] && objects[i][keys[j]];
                if (typeof value === "number" && isFinite(value) && value > 0)
                    return value > 10000 ? value / 1000 : value;
            }
        return 0;
    }
    var objects = [root, track, data, nested];
    var title = typeof root.track === "string" ? root.track
              : pickString([root, data], ["trackName", "title", "musicName", "songName"]);
    if (!title) title = pickString([track, nested], ["trackName", "title", "name", "musicName"]);
    var artist = pickString([root, data], ["artist", "artistName", "artist_name", "singer"]);
    if (!artist) artist = pickString([track, nested], ["artist", "artistName", "artist_name", "singer"]);
    return {
        title: title,
        artist: artist,
        duration: pickNumber(objects, ["duration", "durationSeconds", "length"])
    };
}

function providerSong(lines, name, ctx, durationSeconds, metadata) {
    if (!lines || lines.length === 0) return null;
    var song = Lrc.finalizeLines(lines);
    if (!song || !song.lines || song.lines.length === 0) return null;
    var meta = metadata || {};
    song.providerName = name;
    var duration = typeof durationSeconds === "number" && durationSeconds > 0
            ? durationSeconds : (typeof meta.duration === "number" ? meta.duration : 0);
    song.durMs = duration > 0 ? Math.round(duration * 1000) : 0;
    if (typeof meta.title === "string" && meta.title !== "") song.matchTitle = meta.title;
    if (typeof meta.artist === "string" && meta.artist !== "") song.matchArtist = meta.artist;
    return song;
}

function safeJson(resp) {
    try { return JSON.parse(resp); } catch (e) { return null; }
}

// LiriQo: normalized multi-provider response; native word timestamps are ms.
// GET /v1/lyrics?title=&artist=&duration=
function liriQoToSong(body, ctx) {
    if (!body) return null;
    var root = body.primary || (body.data && body.data.primary) || null;
    if (!root || !root.timed || !root.timed.length) return null;
    var lines = [];
    for (var i = 0; i < root.timed.length; i++) {
        var ln = root.timed[i];
        if (!ln || typeof ln.start !== "number") continue;
        var text = typeof ln.text === "string" ? ln.text : "";
        if (text === "") continue;
        var rawWords = ln.words || (root.words && ln.id !== undefined ? root.words[ln.id] : null);
        var words = null;
        if (rawWords && rawWords.length) {
            words = [];
            for (var j = 0; j < rawWords.length; j++) {
                var w = rawWords[j];
                if (!w || typeof w.start !== "number" || typeof w.text !== "string" || w.text === "")
                    continue;
                words.push({
                    t: w.start,
                    e: typeof w.end === "number" ? w.end : 0,
                    text: w.text
                });
            }
            if (words.length < 2) words = null;
        }
        lines.push({
            t: ln.start,
            e: typeof ln.end === "number" ? ln.end : 0,
            text: text,
            words: words
        });
    }
    var song = providerSong(lines, "LiriQo", ctx, 0, providerTrackInfo(body));
    if (song && root.provider) ctx.log("lyrics: LiriQo upstream " + root.provider);
    return song;
}

function fetchLiriQo(ctx, cb) {
    var url = "https://api.liriqo-alfarrizi.my.id/v1/lyrics?title="
            + encodeURIComponent(ctx.title)
            + "&artist=" + encodeURIComponent(ctx.artist);
    if (ctx.album) url += "&album=" + encodeURIComponent(ctx.album);
    if (ctx.durS > 0) url += "&duration=" + ctx.durS;
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var body = ok && resp ? safeJson(resp) : null;
        cb(body ? liriQoToSong(body, ctx) : null);
    });
}

// LRCMux: direct JSON output, start/end and words are integer milliseconds.
// GET /get?artist=&title=&level=word&format=json
function lrcmuxToSong(body, ctx) {
    if (!body || !body.lines || !body.lines.length) return null;
    var lines = [];
    for (var i = 0; i < body.lines.length; i++) {
        var ln = body.lines[i];
        if (!ln || typeof ln.start !== "number") continue;
        var words = null;
        if (ln.words && ln.words.length) {
            words = [];
            for (var j = 0; j < ln.words.length; j++) {
                var w = ln.words[j];
                if (!w || typeof w.start !== "number" || typeof w.text !== "string") continue;
                words.push({
                    t: w.start,
                    e: typeof w.end === "number" ? w.end : 0,
                    text: w.text
                });
            }
            if (words.length < 2) words = null;
        }
        lines.push({
            t: ln.start,
            e: typeof ln.end === "number" ? ln.end : 0,
            text: typeof ln.text === "string" ? ln.text : "",
            words: words
        });
    }
    var song = providerSong(lines, "LRCMux", ctx,
            body.track && typeof body.track.duration === "number" ? body.track.duration : 0,
            providerTrackInfo(body));
    if (song && body.meta && body.meta.source && body.meta.source.name)
        ctx.log("lyrics: LRCMux upstream " + body.meta.source.name);
    return song;
}

function fetchLrcmux(ctx, cb) {
    var url = "https://api.lrcmux.dev/get?artist=" + encodeURIComponent(ctx.artist)
            + "&title=" + encodeURIComponent(ctx.title)
            + "&level=word&format=json";
    if (ctx.album) url += "&album=" + encodeURIComponent(ctx.album);
    if (ctx.durS > 0) url += "&duration=" + ctx.durS;
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var body = ok && resp ? safeJson(resp) : null;
        cb(body ? lrcmuxToSong(body, ctx) : null);
    });
}

// Lyrica: word=true returns timed_lyrics with word start/end in ms.
function lyricaToSong(body, ctx) {
    var data = body && (body.data || body);
    if (!data || !data.timed_lyrics || !data.timed_lyrics.length) return null;
    var lines = [];
    for (var i = 0; i < data.timed_lyrics.length; i++) {
        var ln = data.timed_lyrics[i];
        if (!ln || typeof ln.start_time !== "number") continue;
        var words = null;
        if (ln.words && ln.words.length) {
            words = [];
            for (var j = 0; j < ln.words.length; j++) {
                var w = ln.words[j];
                var wordText = typeof w.word === "string" ? w.word : w.text;
                if (!w || typeof w.start !== "number" || typeof wordText !== "string" || wordText === "")
                    continue;
                words.push({
                    t: w.start,
                    e: typeof w.end === "number" ? w.end : 0,
                    text: wordText
                });
            }
            if (words.length < 2) words = null;
        }
        lines.push({
            t: ln.start_time,
            e: typeof ln.end_time === "number" ? ln.end_time : 0,
            text: typeof ln.text === "string" ? ln.text : "",
            words: words
        });
    }
    var song = providerSong(lines, "Lyrica", ctx, 0, providerTrackInfo(data));
    if (song && data.source) ctx.log("lyrics: Lyrica upstream " + data.source);
    return song;
}

function fetchLyrica(ctx, cb) {
    var url = "https://wilooper-lyrica.hf.space/lyrics/?artist="
            + encodeURIComponent(ctx.artist) + "&song=" + encodeURIComponent(ctx.title)
            + "&timestamps=true&word=true";
    if (ctx.album) url += "&album=" + encodeURIComponent(ctx.album);
    if (ctx.durS > 0) url += "&duration=" + ctx.durS;
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var body = ok && resp ? safeJson(resp) : null;
        cb(body ? lyricaToSong(body, ctx) : null);
    });
}

// SyncLyrics API exposes Musixmatch/NetEase word timing as per-token offsets
// in seconds relative to each line's absolute start timestamp.
function syncLyricsToSong(body, ctx) {
    var data = body && body.lyrics && body.lyrics.wordSynced;
    var rows = data && data.lyrics;
    if (!rows || !rows.length) return null;
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || typeof row.start !== "number") continue;
        var lineStart = Math.round(row.start * 1000);
        var lineEnd = typeof row.end === "number" ? Math.round(row.end * 1000) : 0;
        var words = [];
        var current = null;
        var tokens = row.syncedLyric || [];
        for (var j = 0; j < tokens.length; j++) {
            var token = tokens[j];
            if (!token || typeof token.character !== "string" || typeof token.time !== "number")
                continue;
            var tokenText = token.character;
            var at = lineStart + Math.round(token.time * 1000);
            if (/^\s+$/.test(tokenText)) {
                if (current) {
                    current.text += tokenText;
                    current.e = at > current.t ? at : 0;
                    words.push(current);
                    current = null;
                }
            } else if (current) {
                // Adjacent non-space chunks belong to the same token.
                current.text += tokenText;
            } else {
                current = { t: at, e: 0, text: tokenText };
            }
        }
        if (current) {
            current.e = lineEnd > current.t ? lineEnd : 0;
            words.push(current);
        }
        var text = typeof row.lyric === "string" ? row.lyric : "";
        if (text !== "")
            lines.push({ t: lineStart, e: lineEnd, text: text, words: words.length >= 2 ? words : null });
    }
    return providerSong(lines, "SyncLyrics API", ctx, 0, providerTrackInfo(body));
}

function fetchSyncLyrics(ctx, cb) {
    var url = "https://lyrics-api.stefdp.lol/lyrics?artist=" + encodeURIComponent(ctx.artist)
            + "&track=" + encodeURIComponent(ctx.title);
    if (ctx.album) url += "&album=" + encodeURIComponent(ctx.album);
    if (ctx.durS > 0) url += "&length=" + Math.round(ctx.durS * 1000);
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var body = ok && resp ? safeJson(resp) : null;
        cb(body ? syncLyricsToSong(body, ctx) : null);
    });
}

// Karalyr is LRCLIB-compatible and returns Enhanced LRC only when a word-timed
// recording exists. Its current public catalogue is intentionally small.
function fetchKaralyr(ctx, cb) {
    var url = "https://karalyr.com/api/get?artist_name=" + encodeURIComponent(ctx.artist)
            + "&track_name=" + encodeURIComponent(ctx.title);
    if (ctx.album) url += "&album_name=" + encodeURIComponent(ctx.album);
    if (ctx.durS > 0) url += "&duration=" + ctx.durS;
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var body = ok && resp ? safeJson(resp) : null;
        var song = body && typeof body.syncedLyrics === "string"
                ? lrcTextToSong(body.syncedLyrics) : null;
        if (song) {
            song.providerName = "Karalyr";
            var karaInfo = providerTrackInfo(body);
            song.durMs = karaInfo.duration > 0 ? Math.round(karaInfo.duration * 1000) : 0;
            if (karaInfo.title) song.matchTitle = karaInfo.title;
            if (karaInfo.artist) song.matchArtist = karaInfo.artist;
            if (body.karalyr && body.karalyr.source)
                ctx.log("lyrics: Karalyr revision from " + body.karalyr.source);
        }
        cb(song);
    });
}

// lrc.red: identify the client, select the closest ISRC result, then fetch its
// word-synced TTML. Their API requires source attribution in the UI.
var LRC_RED_HEADERS = {
    "X-Client-ID": "Chorus-plus (https://github.com/kirch56/Chorus-plus; contact: https://github.com/kirch56/Chorus-plus/issues)"
};

function lrcRedChooseHit(hits, ctx) {
    if (!hits || !hits.length) return null;
    var wantTitle = dmsSearchable(ctx.title);
    var wantArtist = dmsSearchable(ctx.artist);
    var best = null, bestScore = -1;
    for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        if (!h || !h.isrc) continue;
        var title = dmsSearchable(h.title);
        var artist = dmsSearchable(h.artist);
        var titleExact = dmsTitlesEquivalent(ctx.title, h.title);
        var durationMatch = ctx.durS > 0 && typeof h.duration === "number"
                && Math.abs(h.duration - ctx.durS) <= Math.max(3, ctx.durS * 0.01);
        // Do not collapse "(A-Trak Remix)" into the original title during
        // catalogue search. A measured duration match can verify an alias
        // whose provider title omits the edition suffix.
        if (!titleExact && dmsHasVersionTag(ctx.title) && !durationMatch) continue;
        var score = titleExact ? 8 : 0;
        if (title === wantTitle) score += 3;
        else if (title.indexOf(wantTitle) !== -1 || wantTitle.indexOf(title) !== -1) score += 1;
        if (artist === wantArtist) score += 3;
        else if (artist.indexOf(wantArtist) !== -1 || wantArtist.indexOf(artist) !== -1) score += 1;
        if (durationMatch) score += 4;
        else if (ctx.durS > 0 && typeof h.duration === "number") score -= 4;
        if (score > bestScore) { best = h; bestScore = score; }
    }
    return bestScore > 0 ? best : null;
}

function fetchLrcRed(ctx, cb) {
    var q = encodeURIComponent(ctx.title + " " + ctx.artist);
    ctx.httpGet("https://lrc.red/search.json?q=" + q, function (ok, resp) {
        if (ctx.isStale()) return;
        var search = ok && resp ? safeJson(resp) : null;
        var hit = lrcRedChooseHit(search && search.hits, ctx);
        if (!hit) { cb(null); return; }
        var trackUrl = "https://lrc.red/s/" + encodeURIComponent(hit.isrc) + ".json";
        ctx.httpGet(trackUrl, function (ok2, resp2) {
            if (ctx.isStale()) return;
            var track = ok2 && resp2 ? safeJson(resp2) : null;
            if (!track || track.sync !== "word") { cb(null); return; }
            var ttmlUrl = track.files && track.files.ttml
                    ? track.files.ttml : "https://lrc.red/s/" + encodeURIComponent(hit.isrc) + ".ttml";
            ctx.httpGet(ttmlUrl, function (ok3, resp3) {
                if (ctx.isStale()) return;
                var song = ok3 ? ttmlToSong(unwrapTtml(resp3), true) : null;
                if (song) {
                    song.providerName = "lrc.red";
                    song.durMs = typeof track.duration === "number"
                            ? Math.round(track.duration * 1000) : 0;
                    song.matchTitle = hit.title || "";
                    song.matchArtist = hit.artist || "";
                    ctx.log("lyrics: lrc.red source credited (https://lrc.red)");
                }
                cb(song);
            }, LRC_RED_HEADERS);
        }, LRC_RED_HEADERS);
    }, LRC_RED_HEADERS);
}

// AMLL TTML DB: search the community database by metadata, then fetch the
// selected immutable TTML record by its numeric ID.
function fetchAmll(ctx, cb) {
    var url = "https://api.amll.dev/v1/lyrics/search?musicName=" + encodeURIComponent(ctx.title)
            + "&artistName=" + encodeURIComponent(ctx.artist) + "&pageSize=10";
    if (ctx.album) url += "&albumName=" + encodeURIComponent(ctx.album);
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var search = ok && resp ? safeJson(resp) : null;
        var items = search && search.data && search.data.items;
        if (!items || !items.length) { cb(null); return; }

        var selected = null, selectedInfo = null, bestScore = -1;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item || !item.id) continue;
            var info = providerTrackInfo(item);
            if (!info.title && typeof item.musicName === "string") info.title = item.musicName;
            var probe = { matchTitle: info.title, matchArtist: info.artist,
                          durMs: info.duration > 0 ? Math.round(info.duration * 1000) : 0 };
            if (dmsMetadataProblem(ctx, probe) !== "") continue;
            var score = (info.title ? 4 : 0) + (info.artist ? 2 : 0)
                      + (info.duration > 0 ? 2 : 0)
                      + (info.title && dmsTitlesEquivalent(ctx.title, info.title) ? 4 : 0);
            if (score > bestScore) {
                selected = item;
                selectedInfo = info;
                bestScore = score;
            }
        }
        if (!selected) { cb(null); return; }

        var getUrl = "https://api.amll.dev/v1/lyrics/get?id=" + encodeURIComponent(selected.id);
        ctx.httpGet(getUrl, function (ok2, resp2) {
            if (ctx.isStale()) return;
            var body = ok2 && resp2 ? safeJson(resp2) : null;
            var data = body && body.data;
            var song = data && typeof data.lyrics === "string" ? ttmlToSong(data.lyrics) : null;
            if (song) {
                song.providerName = "AMLL TTML DB";
                var amllInfo = providerTrackInfo(data);
                song.durMs = amllInfo.duration > 0 ? Math.round(amllInfo.duration * 1000)
                          : (selectedInfo.duration > 0 ? Math.round(selectedInfo.duration * 1000) : 0);
                song.matchTitle = amllInfo.title || selectedInfo.title
                        || (data.musicNames && data.musicNames.length ? data.musicNames[0] : "");
                song.matchArtist = amllInfo.artist || selectedInfo.artist || "";
                if (data.musicNames && data.musicNames.length)
                    ctx.log("lyrics: AMLL TTML DB matched " + data.musicNames[0]);
            }
            cb(song);
        });
    });
}

// LyricsDB has a public, no-key fuzzy lookup and returns TTML (word/syllable
// timing) directly. New uncached tracks are subject to its 6/minute fair-use cap.
function fetchLyricsDB(ctx, cb) {
    var url = "https://lyricsdb.kollod.dev/api/lyrics/fuzzy?title=" + encodeURIComponent(ctx.title)
            + "&artist=" + encodeURIComponent(ctx.artist) + "&format=ttml";
    if (ctx.album) url += "&album=" + encodeURIComponent(ctx.album);
    if (ctx.durS > 0) url += "&duration=" + ctx.durS;
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var song = ok ? ttmlToSong(unwrapTtml(resp)) : null;
        if (song) {
            song.providerName = "LyricsDB";
            var dbInfo = providerTrackInfo(safeJson(resp));
            song.durMs = dbInfo.duration > 0 ? Math.round(dbInfo.duration * 1000) : 0;
            if (dbInfo.title) song.matchTitle = dbInfo.title;
            if (dbInfo.artist) song.matchArtist = dbInfo.artist;
        }
        cb(song);
    });
}

// ---------- registry ----------

// wordSync marks providers that can return word/syllable-level timing. Some
// providers can still fall back to line-level results, but remain in the
// word-capable race so a later karaoke answer can upgrade the result.
var PROVIDERS = [
    { id: "betterlyrics", name: "Better Lyrics", wordSync: true, fetch: fetchBetterLyrics },
    { id: "unison", name: "Unison", wordSync: true, fetch: fetchUnison },
    { id: "lyricsplus", name: "LyricsPlus", wordSync: true, fetch: fetchLyricsPlus },
    { id: "lrcmux", name: "LRCMux", wordSync: true, fetch: fetchLrcmux },
    { id: "liriqo", name: "LiriQo", wordSync: true, fetch: fetchLiriQo },
    { id: "lyrica", name: "Lyrica", wordSync: true, fetch: fetchLyrica },
    { id: "synclyrics", name: "SyncLyrics API", wordSync: true, fetch: fetchSyncLyrics },
    { id: "amll", name: "AMLL TTML DB", wordSync: true, fetch: fetchAmll },
    { id: "lrc-red", name: "lrc.red", wordSync: true, fetch: fetchLrcRed },
    { id: "lyricsdb", name: "LyricsDB", wordSync: true, fetch: fetchLyricsDB },
    { id: "karalyr", name: "Karalyr", wordSync: true, fetch: fetchKaralyr },
    { id: "kugou", name: "KuGou", wordSync: false, fetch: fetchKugou },
    { id: "lrclib", name: "LRCLIB", wordSync: true, fetch: fetchLrclib },
    { id: "youtube", name: "YouTube Music", wordSync: false, fetch: fetchYoutubeMusic }
];



function getProvider(id) {
    for (var i = 0; i < PROVIDERS.length; i++)
        if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return null;
}

// ---- DMS (dux-shell) pick: which provider's lyrics win ----
// Ported from dux-go lyrics/score.go: prefer lyrics whose reported length
// matches the track (plausible), then timed over untimed, then ones whose
// duration the provider verified, then the ones whose timing sits closest to
// another provider's. Provider priority order decides among those that agree.

var DMS_END_SLACK_MS = 3000;          // last line may start up to 3 s past the end
var DMS_LENGTH_SLACK_MS = 2000;       // catalogs round lengths; short tracks need the floor
var DMS_LENGTH_SHARE = 0.01;          // 1% of the track
var DMS_MIN_AGREE_BAND_MS = 250;      // gaps within one band count as agreement
var DMS_AGREE_BAND_SHARE = 0.001;     // 0.1% of the track
var DMS_MIN_AGREE_LINES = 3;          // fewer aligned lines than this proves nothing
var DMS_MAX_ALIGN_CELLS = 250000;     // bounds the LCS table
var DMS_SYNC_GRACE_MS = 2000;         // wait after the first found lyrics (dux-go syncGrace)
var DMS_LOOKUP_TIMEOUT_MS = 12000;    // whole-race deadline (dux-go lookupTimeout)

// searchable drops notes like "(Radio Edit)", quotes and punctuation, so the
// alignment can pair lines across catalogs. Go's unicode.IsLetter keeps CJK
// and Cyrillic; the explicit punctuation ranges stand in for "not a letter".
function dmsSearchable(text) {
    return String(text || "").toLowerCase()
        .replace(/[(\[（【][^)\]）】]*[)\]）】]/g, " ")
        .replace(/[\u2000-\u206F\u2100-\u214F\u2190-\u2BFF\u2E00-\u2E7F\u3000-\u303F\uFE10-\uFE6F\uFF01-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]+/g, " ")
        .replace(/[^0-9A-Za-z\u00C0-\u00FF\u0100-\u04FF\u0590-\u08FF\u0900-\u9FFF\uA000-\uFFDC]+/g, " ")
        .replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

// Unlike dmsSearchable (used to compare lyric lines), title identity must keep
// edition suffixes. Removing "(A-Trak Remix)" here silently merges the remix
// with the original recording.
function dmsTitleKey(text) {
    return String(text || "").toLowerCase()
        .replace(/[()[\]{}（）【】]/g, " ")
        .replace(/[\u2000-\u206F\u2100-\u214F\u2190-\u2BFF\u2E00-\u2E7F\u3000-\u303F\uFE10-\uFE6F\uFF01-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]+/g, " ")
        .replace(/[^0-9A-Za-z\u00C0-\u00FF\u0100-\u04FF\u0590-\u08FF\u0900-\u9FFF\uA000-\uFFDC]+/g, " ")
        .replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

function dmsTitlesEquivalent(a, b) {
    var aa = dmsTitleKey(a).split(" ");
    var bb = dmsTitleKey(b).split(" ");
    if (aa.length === 1 && aa[0] === "") return false;
    if (aa.length !== bb.length) return false;
    for (var i = 0; i < aa.length; i++) {
        if (aa[i] === bb[i]) continue;
        // Streaming catalogues occasionally pluralize a title word.
        if (aa[i].length > 3 && bb[i].length > 3
                && (aa[i] + "s" === bb[i] || bb[i] + "s" === aa[i])) continue;
        return false;
    }
    return true;
}

function dmsHasVersionTag(title) {
    return /\b(?:remix(?:ed)?|radio\s+edit|radio\s+version|dub|club\s+mix|extended\s+mix|original\s+mix|dance\s+mix|edit|instrumental|live|acoustic|remaster(?:ed)?|version|demo|sped\s*up|slowed|nightcore)\b/i.test(String(title || ""));
}

function dmsArtistCompatible(want, got) {
    var a = dmsTitleKey(want), b = dmsTitleKey(got);
    return a !== "" && b !== "" && (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1);
}

// A versioned request must be backed by the same version title or by a
// catalogue duration that genuinely matches the playing file. Providers must
// never claim the player's duration when their own response omits it.
function dmsMetadataProblem(ctx, song) {
    if (!song) return "missing";

    // Metadata matching is only a hard gate when the player explicitly asks
    // for a distinct edition (Remix, Radio Edit, Live, etc.). Most lyrics APIs
    // do not return track title or duration at all; rejecting those answers
    // made ordinary tracks lose every available lyric source.
    if (!dmsHasVersionTag(ctx.title)) return "";

    var durationVerified = ctx.durS > 0 && song.durMs > 0
            && dmsProblemWith(ctx, song) === "";
    if (song.matchArtist && ctx.artist
            && !dmsArtistCompatible(ctx.artist, song.matchArtist))
        return "artist mismatch";

    // A provider's exact edition title is stronger evidence than rounded
    // duration metadata. If it only returns the base title, require a real
    // source-reported duration match before accepting it as the remix.
    if (song.matchTitle && dmsTitlesEquivalent(ctx.title, song.matchTitle))
        return "";
    if (durationVerified) return "";
    if (!song.matchTitle) return "version not verified";
    return "track/version mismatch";
}


function dmsTimedCues(song) {
    if (!song || !song.lines) return [];
    var out = [];
    for (var i = 0; i < song.lines.length; i++)
        if (song.lines[i].text && song.lines[i].text !== "") out.push(song.lines[i]);
    return out;
}

// problemWith: lyrics timed for another cut, such as a music video with intro
// footage. "" = plausible, "length"/"overrun" = a stated problem.
function dmsProblemWith(ctx, song) {
    var want = ctx.durS > 0 ? ctx.durS : 0;
    if (want <= 0) return "";
    if (song.durMs > 0) {
        var reported = song.durMs / 1000;
        if (Math.max(reported - want, want - reported) > Math.max(DMS_LENGTH_SLACK_MS / 1000, want * DMS_LENGTH_SHARE))
            return "length";
    }
    var cues = dmsTimedCues(song);
    if (cues.length > 0 && cues[cues.length - 1].t > want * 1000 + DMS_END_SLACK_MS)
        return "overrun";
    return "";
}

// medianGap aligns two candidates' lines by text (LCS keeps repeated choruses
// paired in order) and compares their starts. A constant offset or a drift
// both raise the median. Returns -1 when too few lines pair up.
function dmsMedianGap(a, b) {
    if (a.length * b.length > DMS_MAX_ALIGN_CELLS) return -1;
    var ta = [], tb = [];
    for (var i = 0; i < a.length; i++) ta.push(dmsSearchable(a[i].text));
    for (var j = 0; j < b.length; j++) tb.push(dmsSearchable(b[j].text));
    // LCS table
    var table = [];
    for (var r = 0; r <= a.length; r++) {
        var row = new Array(b.length + 1);
        for (var c2 = 0; c2 <= b.length; c2++) row[c2] = 0;
        table.push(row);
    }
    for (var i2 = a.length - 1; i2 >= 0; i2--) {
        for (var j2 = b.length - 1; j2 >= 0; j2--) {
            if (ta[i2] !== "" && ta[i2] === tb[j2])
                table[i2][j2] = table[i2 + 1][j2 + 1] + 1;
            else
                table[i2][j2] = Math.max(table[i2 + 1][j2], table[i2][j2 + 1]);
        }
    }
    var gaps = [];
    for (var p = 0, q = 0; p < a.length && q < b.length; ) {
        if (ta[p] !== "" && ta[p] === tb[q]) {
            gaps.push(Math.abs(a[p].t - b[q].t));
            p++; q++;
        } else if (table[p + 1][q] >= table[p][q + 1]) {
            p++;
        } else {
            q++;
        }
    }
    if (gaps.length < DMS_MIN_AGREE_LINES) return -1;
    gaps.sort(function (x, y) { return x - y; });
    return gaps[gaps.length >> 1];
}

// pick over the race results: results[i] = song object (already found + named)
// or null. Returns the winning song or null.
function dmsPick(ctx, results) {
    var candidates = [];
    for (var i = 0; i < results.length; i++) {
        var song = results[i];
        if (!song || !song.lines || song.lines.length === 0) continue;
        var metadataProblem = dmsMetadataProblem(ctx, song);
        if (metadataProblem !== "") {
            ctx.log("lyrics: rejected " + (song.providerName || "provider")
                    + " (" + metadataProblem + ")");
            continue;
        }
        var cues = dmsTimedCues(song);
        candidates.push({
            priority: i,
            song: song,
            cues: cues,
            plausible: dmsProblemWith(ctx, song) === "",
            verified: ctx.durS > 0 && song.durMs > 0,
            timed: cues.length > 0,
            nearest: Number.POSITIVE_INFINITY
        });
    }
    if (candidates.length === 0) return null;
    for (var a = 0; a < candidates.length; a++) {
        for (var b = a + 1; b < candidates.length; b++) {
            var ca = candidates[a], cb2 = candidates[b];
            if (!ca.plausible || !cb2.plausible) continue;
            var gap = dmsMedianGap(ca.cues, cb2.cues);
            if (gap < 0) continue;
            if (gap < ca.nearest) ca.nearest = gap;
            if (gap < cb2.nearest) cb2.nearest = gap;
        }
    }
    var band = Math.max(DMS_MIN_AGREE_BAND_MS, (ctx.durS > 0 ? ctx.durS * 1000 : 0) * DMS_AGREE_BAND_SHARE);
    function better(x, y) {
        if (x.plausible !== y.plausible) return x.plausible ? x : y;
        // word-level sweep beats line-level sync whenever both are plausible:
        // the karaoke view stays alive when a word source answers (DMS keeps
        // the same preference in its provider ordering)
        var xw = x.song.wordSync === true, yw = y.song.wordSync === true;
        if (xw !== yw) return xw ? x : y;
        if (x.timed !== y.timed) return x.timed ? x : y;
        if (x.verified !== y.verified) return x.verified ? x : y;
        var bx = Math.floor(x.nearest / band), by = Math.floor(y.nearest / band);
        if (bx !== by) return bx < by ? x : y;
        return x.priority <= y.priority ? x : y;
    }
    var best = candidates[0];
    for (var c = 1; c < candidates.length; c++)
        best = better(best, candidates[c]);
    return best.song;
}

// Tries every provider at once, DMS-style, and calls cb with the best answer
// (or null). ctx.enabled (optional) restricts the race; undefined or empty
// means all of them. The best answer so far is shown after DMS_SYNC_GRACE_MS,
// but a line-level winner does not close the race: word-capable providers keep
// racing until DMS_LOOKUP_TIMEOUT_MS and a late plausible word-level song is
// pushed through a second cb call, so the karaoke sweep can replace plain
// lines without a refetch (the widget re-applies and re-caches it). Word
// providers that answered empty get one retry. ctx.later(ms, fn) schedules a
// one-shot callback (a QML Timer from the widget).
function fetchAll(ctx, cb) {
    var enabled = ctx.enabled;
    var chain = [];
    for (var i = 0; i < PROVIDERS.length; i++)
        if (!enabled || enabled.length === 0
                || enabled.indexOf(PROVIDERS[i].id) !== -1) chain.push(PROVIDERS[i]);
    if (chain.length === 0) { cb(null); return; }

    var results = new Array(chain.length);
    var wordIdx = [];
    for (var w = 0; w < chain.length; w++)
        if (chain[w].wordSync === true) wordIdx.push(w);

    var answered = 0, foundCount = 0, finished = false, firstFoundAt = 0;
    var graceSet = false, closed = false, winner = null, retried = false;

    function pendingWordNames() {
        var names = [];
        for (var i = 0; i < wordIdx.length; i++)
            if (results[wordIdx[i]] === undefined) names.push(chain[wordIdx[i]].name);
        return names.join(", ");
    }

    function finish() {
        if (finished) return;
        finished = true;
        winner = dmsPick(ctx, results) || null;
        if (winner) ctx.log("lyrics: " + (winner.providerName || "unknown provider")
                            + " won the race" + (winner.wordSync ? " (word-level)" : ""));
        else ctx.log("lyrics: no provider had synced lyrics yet");
        if ((!winner || winner.wordSync !== true) && pendingWordNames() !== "")
            ctx.log("lyrics: line-level winner while word providers are still racing ("
                    + pendingWordNames() + "); will upgrade if one answers word-level");
        retryFailedWordProviders();
        cb(winner);
    }

    function maybeFinish() {
        if (finished) return;
        if (answered >= chain.length) { finish(); return; }
        if (foundCount > 0 && Date.now() - firstFoundAt >= DMS_SYNC_GRACE_MS) finish();
    }

    // Word providers that came back empty get exactly one retry when the
    // winner is only line-level: transient TLS/DNS hiccups must not silently
    // downgrade the track to plain lines for good.
    function retryFailedWordProviders() {
        if (retried || (winner && winner.wordSync === true)) return;
        var failed = [];
        for (var i = 0; i < wordIdx.length; i++)
            if (results[wordIdx[i]] === null) failed.push(wordIdx[i]);
        if (failed.length === 0) return;
        retried = true;
        ctx.later(600, function () {
            if (closed || ctx.isStale() || (winner && winner.wordSync === true)) return;
            for (var r = 0; r < failed.length; r++) {
                (function (idx) {
                    ctx.log("lyrics: retrying " + chain[idx].name);
                    try {
                        chain[idx].fetch(ctx, function (song) { got(idx, song); });
                    } catch (e) {
                        ctx.log("lyrics: " + chain[idx].name + " retry failed: " + e);
                    }
                })(failed[r]);
            }
        });
    }

    // Late answers may only improve the result: a plausible word-level song
    // replaces line-level lyrics, any plausible song fills an empty slot.
    // Everything else is logged and dropped, never a downgrade.
    function tryUpgrade(idx, song) {
        if (closed || !song || !song.lines || song.lines.length === 0) return;
        var name = song.providerName || chain[idx].name;
        if (winner && winner.wordSync === true) {
            ctx.log("lyrics: late " + name + " answer dropped (word-level already active)");
            return;
        }
        var metadataProblem = dmsMetadataProblem(ctx, song);
        if (metadataProblem !== "") {
            ctx.log("lyrics: late " + name + " answer rejected (" + metadataProblem + ")");
            return;
        }
        if (winner && song.wordSync !== true) {
            ctx.log("lyrics: late " + name + " answer dropped (line-level, not an upgrade)");
            return;
        }
        ctx.log("lyrics: upgraded to " + name + (song.wordSync ? " (word-level)" : ""));
        winner = song;
        cb(song);
    }

    function got(idx, song) {
        if (closed || ctx.isStale()) return;
        // stamp the winner's source so the UI can credit it ("Lyrics from X")
        if (song && song.lines && song.lines.length > 0 && !song.providerName)
            song.providerName = chain[idx].name;
        if (finished) {
            if (song && song.lines && song.lines.length > 0)
                ctx.log("lyrics: late answer from " + chain[idx].name
                        + " (" + song.lines.length + " lines"
                        + (song.wordSync ? ", word-level" : "") + ")");
            tryUpgrade(idx, song);
            return;
        }
        results[idx] = song;
        answered++;
        if (song && song.lines && song.lines.length > 0) {
            foundCount++;
            if (firstFoundAt === 0) {
                firstFoundAt = Date.now();
                if (ctx.later && !graceSet) {
                    graceSet = true;
                    ctx.later(DMS_SYNC_GRACE_MS, maybeFinish);
                }
            }
        }
        maybeFinish();
    }

    for (var r = 0; r < chain.length; r++) {
        (function (idx) {
            var p = chain[idx];
            ctx.log("lyrics: racing " + p.name);
            try {
                p.fetch(ctx, function (song) { got(idx, song); });
            } catch (e) {
                ctx.log("lyrics: " + p.name + " failed: " + e);
                results[idx] = null;
                answered++;
                maybeFinish();
            }
        })(r);
    }
    // The lookup deadline only closes the upgrade window now; dmsPick already
    // ran at finish(). Late answers past this point are ignored.
    if (ctx.later) ctx.later(DMS_LOOKUP_TIMEOUT_MS, function () {
        closed = true;
    });
    else maybeFinish();
}

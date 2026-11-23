// Lyrics providers, DMS-style (Dux Modular Shell / dux-go lyrics client).
// Providers: Better Lyrics, Unison, LyricsPlus, KuGou, LRCLIB, YouTube Music.
// Every enabled provider is raced at once and the best answer wins:
//   ctx = {
//     title, artist, album, durS,      // track metadata, durS = duration in seconds (<= 0 if unknown)
//     enabled,                         // array of provider ids to race, priority order
//     later(ms, fn),                   // one-shot callback scheduler (QML Timer)
//     httpGet(url, cb),                // cb(ok, body)
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

// Apple Music style TTML nests echo / background-vocal groups in wrapper
// spans that carry no timing of their own (<span ttm:role="x-bg"><span
// begin="..">(My</span>...). A flat per-word scan eats the wrapper's first
// child and drops the whole group, so every wrapper without begin=/end= is
// unwrapped first and only the timed leaves stay.
function flattenTtmlSpans(s) {
    var toks = [], re = /<\/?span\b[^>]*>/g, m, last = 0;
    while ((m = re.exec(s)) !== null) {
        if (m.index > last)
            toks.push({ t: "x", s: s.slice(last, m.index) });
        toks.push({ t: m[0].charAt(1) === "/" ? "c" : "o", s: m[0],
                    timed: /\b(?:begin|end)\s*=/.test(m[0]) });
        last = re.lastIndex;
    }
    if (last < s.length)
        toks.push({ t: "x", s: s.slice(last) });
    var out = "", stack = [];
    for (var i = 0; i < toks.length; i++) {
        var tk = toks[i];
        if (tk.t === "o") {
            stack.push(tk.timed);
            if (tk.timed) out += tk.s;
        } else if (tk.t === "c") {
            if (stack.pop()) out += tk.s;
        } else {
            out += tk.s;
        }
    }
    return out;
}

// Word-level spans inside a TTML <p>: <span begin=".." end="..">word</span>.
// Whitespace between spans carries the spaces between words, so it is kept
// (appended to the preceding word) and the rendered line matches the source.
function parseTTMLWords(inner) {
    var flat = flattenTtmlSpans(String(inner));
    var re = /<span\b([^>]*)>([\s\S]*?)<\/span>([\s\S]*?)(?=<span\b|$)/g;
    var words = [], m;
    while ((m = re.exec(flat)) !== null) {
        var bt = /\bbegin\s*=\s*["']([^"']+)["']/.exec(m[1]);
        var et = /\bend\s*=\s*["']([^"']+)["']/.exec(m[1]);
        var t = bt ? parseTTMLTime(bt[1]) : -1;
        var e = et ? parseTTMLTime(et[1]) : 0;
        var text = m[2].replace(/<[^>]*>/g, "");
        var gap = m[3].replace(/<[^>]*>/g, "");
        if (t < 0 || text.replace(/\s/g, "") === "") continue;
        if (gap !== "" && !/\S/.test(gap)) text += gap;
        words.push({ t: t, e: e > t ? e : 0, text: text });
    }
    // Echo groups like "(My conscience)" are glued to the previous word in
    // the source TTML (no whitespace before the group's span); the lyric
    // text always spaces them off.
    for (var i = 1; i < words.length; i++)
        if (/^[(（]/.test(words[i].text) && !/\s$/.test(words[i - 1].text))
            words[i - 1].text += " ";
    return words.length >= 2 ? words : null;
}

// TTML -> song object. Regex-based because the QML JS engine has no DOMParser.
// Apple Music style TTML (itunes:timing="Word") carries one <span> per word;
// when a line has at least two timed spans it becomes a word-level line.
function ttmlToSong(ttml) {
    if (!ttml || String(ttml).indexOf("<") === -1) return null;
    var out = [];
    var re = /<p\b[^>]*?begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
    var m;
    while ((m = re.exec(String(ttml))) !== null) {
        var t = parseTTMLTime(m[1]);
        var open = m[0].slice(0, m[0].indexOf(">"));
        var endM = /\bend\s*=\s*["']([^"']+)["']/.exec(open);
        var e = endM ? parseTTMLTime(endM[1]) : 0;
        var words = parseTTMLWords(m[2]);
        // Same echo spacing as parseTTMLWords applies to the words: glued
        // "(Echo)" groups are spaced off the main vocal in the rendered text.
        var text = m[2].replace(/<[^>]*>/g, "").replace(/([^\s(（])\(/g, "$1 (")
                   .replace(/\s+/g, " ").trim();
        if (t < 0 || text === "") continue;
        out.push({ t: t, e: e > t ? e : 0, text: text, words: words });
    }
    if (out.length === 0) return null;
    return Lrc.finalizeLines(out);
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
        if (song) { cb(song); return; }
        var url2 = "https://api.betterlyrics.org/kugou/getLyrics?s=" + encodeURIComponent(ctx.title)
                 + "&a=" + encodeURIComponent(ctx.artist)
                 + "&d=" + (ctx.durS > 0 ? ctx.durS : 0);
        ctx.httpGet(url2, function (ok2, resp2) {
            if (ctx.isStale()) return;
            if (!ok2 || !resp2) { cb(null); return; }
            var body;
            try { body = JSON.parse(resp2); } catch (e) { cb(null); return; }
            cb(body && typeof body.lyrics === "string" ? lrcTextToSong(body.lyrics) : null);
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
                if (song) { cb(song); return; }
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
            if (song) { cb(song); return; }
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
                    // prefer a word-synced record, then the first synced one
                    var wordRec = null, syncRec = null;
                    for (var i = 0; i < arr.length; i++) {
                        if (!wordRec && arr[i].hasWordSync && arr[i].lyricsfile)
                            wordRec = arr[i];
                        if (!syncRec && arr[i].syncedLyrics) syncRec = arr[i];
                    }
                    best = wordRec || syncRec || null;
                } catch (e) {}
            }
            cb(best ? lrclibRecordToSong(best) : null);
        });
    });
}

// ---------- registry ----------

// wordSync marks providers that can return word/syllable-level timings:
// Better Lyrics and Unison serve Apple Music TTML, LyricsPlus aggregates
// Musixmatch word sync (syllabus arrays). KuGou, LRCLIB (mostly) and
// YouTube Music are line-level.
//
// The order is DMS's builtin priority (Dux Modular Shell MediaOptions /
// dux-go DefaultProviders). Every enabled provider is raced at once and the
// best answer wins, so the order only decides among answers that agree.
var PROVIDERS = [
    { id: "betterlyrics", name: "Better Lyrics", wordSync: true, fetch: fetchBetterLyrics },
    { id: "unison", name: "Unison", wordSync: true, fetch: fetchUnison },
    { id: "lyricsplus", name: "LyricsPlus", wordSync: true, fetch: fetchLyricsPlus },
    { id: "kugou", name: "KuGou", wordSync: false, fetch: fetchKugou },
    { id: "lrclib", name: "LRCLIB", wordSync: false, fetch: fetchLrclib },
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

// Tries all enabled providers at once, DMS-style, and calls cb with the best
// answer (or null). The wait for the stragglers after the first match is
// bounded by DMS_SYNC_GRACE_MS, the whole race by DMS_LOOKUP_TIMEOUT_MS.
// ctx.later(ms, fn) schedules a one-shot callback (a QML Timer from the widget).
function fetchAll(ctx, cb) {
    var enabled = ctx.enabled || [];
    var chain = [];
    for (var i = 0; i < PROVIDERS.length; i++)
        if (enabled.indexOf(PROVIDERS[i].id) !== -1) chain.push(PROVIDERS[i]);
    if (chain.length === 0) { cb(null); return; }

    var results = new Array(chain.length);
    var answered = 0, foundCount = 0, finished = false, firstFoundAt = 0;
    var graceSet = false;

    function finish() {
        if (finished) return;
        finished = true;
        var song = dmsPick(ctx, results);
        if (song) ctx.log("lyrics: " + (song.providerName || "unknown provider") + " won the race"
                          + (song.wordSync ? " (word-level)" : ""));
        else ctx.log("lyrics: no provider had synced lyrics");
        cb(song || null);
    }

    function maybeFinish() {
        if (finished) return;
        if (answered >= chain.length) { finish(); return; }
        if (foundCount > 0 && Date.now() - firstFoundAt >= DMS_SYNC_GRACE_MS) finish();
    }

    function got(idx, song) {
        if (finished || ctx.isStale()) return;
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
    if (ctx.later) ctx.later(DMS_LOOKUP_TIMEOUT_MS, finish);
    else maybeFinish();
}

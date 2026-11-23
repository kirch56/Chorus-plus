// Extra lyrics providers, used as fallbacks when LRCLIB has no synced lyrics.
// Providers: Better Lyrics, Unison, LyricsPlus, KuGou, YouTube Music.
// Every provider takes a context object and returns a song object via a
// callback: { lines: [{ t, e, text, words: [{t,e,text}] | null }], wordSync }.
//   ctx = {
//     title, artist, album, durS,      // track metadata, durS = duration in seconds (<= 0 if unknown)
//     enabled,                         // array of provider ids to try, in priority order
//     wordSyncPriority,                // prefer word-level capable providers first (default true)
//     lineFallback,                    // song object to return when nothing better is found
//     httpGet(url, cb),                // cb(ok, body)
//     httpPostJson(url, body, cb),     // cb(ok, body)
//     isStale(),                       // true if the current song changed while we were fetching
//     log(msg)
//   }
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

// Word-level spans inside a TTML <p>: <span begin=".." end="..">word</span>.
// Whitespace between spans carries the spaces between words, so it is kept
// (appended to the preceding word) and the rendered line matches the source.
function parseTTMLWords(inner) {
    var re = /<span\b([^>]*)>([\s\S]*?)<\/span>([\s\S]*?)(?=<span\b|$)/g;
    var words = [], m;
    while ((m = re.exec(inner)) !== null) {
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
        var text = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
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

// ---------- Better Lyrics ----------
// 1. GET https://api.betterlyrics.org/getLyrics?s={song}&a={artist}&al={album}&d={duration}
//    Returns TTML (itunes:timing="Word" when word timings exist). Cache hits
//    need no key; cache misses return 401 (no keys are being issued), which we
//    treat as "no lyrics here".
// 2. Fallback: GET /kugou/getLyrics?s={song}&a={artist}&d={duration}
//    Returns { lyrics: "...LRC..." } and never needs a key.

function fetchBetterLyrics(ctx, cb) {
    var url = "https://api.betterlyrics.org/getLyrics?s=" + encodeURIComponent(ctx.title)
            + "&a=" + encodeURIComponent(ctx.artist)
            + "&al=" + encodeURIComponent(ctx.album || "")
            + "&d=" + (ctx.durS > 0 ? ctx.durS : 0);
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var song = ok && resp ? ttmlToSong(resp) : null;
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

// ---------- registry ----------

// wordSync marks providers that can return word/syllable-level timings:
// Better Lyrics and Unison serve Apple Music TTML, LyricsPlus aggregates
// Musixmatch word sync (syllabus arrays). KuGou and YouTube Music are
// line-level only.
var PROVIDERS = [
    { id: "betterlyrics", name: "Better Lyrics", wordSync: true, fetch: fetchBetterLyrics },
    { id: "unison", name: "Unison", wordSync: true, fetch: fetchUnison },
    { id: "lyricsplus", name: "LyricsPlus", wordSync: true, fetch: fetchLyricsPlus },
    { id: "kugou", name: "KuGou", wordSync: false, fetch: fetchKugou },
    { id: "youtube", name: "YouTube Music", wordSync: false, fetch: fetchYoutubeMusic }
];

function getProvider(id) {
    for (var i = 0; i < PROVIDERS.length; i++)
        if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return null;
}

// Tries the enabled providers for lyrics, cb(song) with the first match or
// cb(lineFallback/null) when all of them miss.
//
// With wordSyncPriority (the default) the word-level capable providers are
// tried first: the first word-level match wins immediately. A line-level
// match from those providers is kept as a fallback — trying the rest of the
// word-level sources may still turn up real word timings. Only when no
// word-level source matched does the best line-level result (including
// ctx.lineFallback, e.g. LRCLIB line lyrics) get used, and the line-only
// providers after it are skipped: they cannot do any better.
function fetchAll(ctx, cb) {
    var enabled = ctx.enabled || [];
    var chain = [];
    for (var i = 0; i < PROVIDERS.length; i++)
        if (enabled.indexOf(PROVIDERS[i].id) !== -1) chain.push(PROVIDERS[i]);
    if (chain.length === 0) { cb(ctx.lineFallback || null); return; }

    var wordPriority = ctx.wordSyncPriority !== false;
    var queue = [];
    if (wordPriority)
        for (var w = 0; w < chain.length; w++)
            if (chain[w].wordSync) queue.push(chain[w]);
    for (var r = 0; r < chain.length; r++)
        if (queue.indexOf(chain[r]) === -1) queue.push(chain[r]);

    var lineFallback = ctx.lineFallback || null;
    var idx = -1;
    function next() {
        // a line-level match already in hand: only word-level sources left in
        // the queue can improve on it
        if (lineFallback) {
            var more = false;
            for (var q = idx + 1; q < queue.length; q++)
                if (queue[q].wordSync) { more = true; break; }
            if (!more) { cb(lineFallback); return; }
        }
        idx += 1;
        if (idx >= queue.length) { cb(lineFallback); return; }
        if (ctx.isStale()) return;
        var p = queue[idx];
        ctx.log("lyrics: trying " + p.name);
        try {
            p.fetch(ctx, function (song) {
                if (ctx.isStale()) return;
                if (song && song.lines && song.lines.length) {
                    // without word-sync priority the first match wins, whatever
                    // its granularity
                    if (song.wordSync || !wordPriority) {
                        ctx.log("lyrics: found on " + p.name
                                + (song.wordSync ? " (word-level)" : ""));
                        cb(song);
                        return;
                    }
                    if (!lineFallback) {
                        ctx.log("lyrics: found on " + p.name + " (line-level)");
                        lineFallback = song;
                    }
                }
                next();
            });
        } catch (e) {
            ctx.log("lyrics: " + p.name + " failed: " + e);
            next();
        }
    }
    next();
}

// Extra lyrics providers, used as fallbacks when LRCLIB has no synced lyrics.
// Providers: Better Lyrics, Unison, LyricsPlus, KuGou, YouTube Music.
// Every provider takes a context object and returns LRC text via a callback:
//   ctx = {
//     title, artist, album, durS,      // track metadata, durS = duration in seconds (<= 0 if unknown)
//     enabled,                         // array of provider ids to try, in priority order
//     httpGet(url, cb),                // cb(ok, body)
//     httpPostJson(url, body, cb),     // cb(ok, body)
//     isStale(),                       // true if the current song changed while we were fetching
//     log(msg)
//   }
.pragma library

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

// TTML -> LRC. Regex-based because the QML JS engine has no DOMParser.
// Whitespace between <span> elements carries the spaces between words, so
// tags are stripped but whitespace is kept, then collapsed.
function ttmlToLrc(ttml) {
    if (!ttml || String(ttml).indexOf("<") === -1) return null;
    var out = [];
    var re = /<p\b[^>]*?begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
    var m;
    while ((m = re.exec(String(ttml))) !== null) {
        var t = parseTTMLTime(m[1]);
        var text = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        if (t >= 0 && text !== "") out.push(msToLrcTime(t) + text);
    }
    return out.length > 0 ? out.join("\n") : null;
}

// YouTube timedtext json3 -> LRC.
function json3ToLrc(jsonText) {
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
        out.push(msToLrcTime(ev.tStartMs) + text);
    }
    return out.length > 0 ? out.join("\n") : null;
}

// Keep only lines that carry a [mm:ss.xx] timestamp, drop metadata headers.
function cleanLrc(text) {
    if (!text) return null;
    var lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
    var re = /^\[(\d+):(\d+)(?:\.\d+)?\]/;
    var ok = [];
    for (var i = 0; i < lines.length; i++)
        if (re.test(lines[i])) ok.push(lines[i]);
    return ok.length > 0 ? ok.join("\n") : null;
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
//    Returns TTML. Cache hits need no key; cache misses return 401 (no keys are
//    being issued), which we treat as "no lyrics here".
// 2. Fallback: GET /kugou/getLyrics?s={song}&a={artist}&d={duration}
//    Returns { lyrics: "...LRC..." } and never needs a key.

function fetchBetterLyrics(ctx, cb) {
    var url = "https://api.betterlyrics.org/getLyrics?s=" + encodeURIComponent(ctx.title)
            + "&a=" + encodeURIComponent(ctx.artist)
            + "&al=" + encodeURIComponent(ctx.album || "")
            + "&d=" + (ctx.durS > 0 ? ctx.durS : 0);
    ctx.httpGet(url, function (ok, resp) {
        if (ctx.isStale()) return;
        var lrc = ok && resp ? ttmlToLrc(resp) : null;
        if (lrc) { cb(lrc); return; }
        var url2 = "https://api.betterlyrics.org/kugou/getLyrics?s=" + encodeURIComponent(ctx.title)
                 + "&a=" + encodeURIComponent(ctx.artist)
                 + "&d=" + (ctx.durS > 0 ? ctx.durS : 0);
        ctx.httpGet(url2, function (ok2, resp2) {
            if (ctx.isStale()) return;
            if (!ok2 || !resp2) { cb(null); return; }
            var body;
            try { body = JSON.parse(resp2); } catch (e) { cb(null); return; }
            cb(body && typeof body.lyrics === "string" ? cleanLrc(body.lyrics) : null);
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
        var lrc = null;
        if (fmt === "lrc") lrc = cleanLrc(body.data.lyrics);
        else if (fmt === "ttml") lrc = ttmlToLrc(body.data.lyrics);
        // "plain" is not synced; skip it.
        if (lrc) {
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
        cb(lrc);
    });
}

// ---------- LyricsPlus ----------
// GET {base}/v2/lyrics/get?title=&artist=&album=&duration=&source=...
// Returns { type, lyrics: [{ time (ms), duration (ms), text, ... }], cached }.

var LYRICSPLUS_BASES = [
    "https://lyricsplus.binimum.org",
    "https://lyricsplus.prjktla.my.id",
    "https://lyricsplus-seven.vercel.app"
];

function lyricsPlusToLrc(body) {
    if (!body || !body.lyrics || !body.lyrics.length) return null;
    var out = [];
    for (var i = 0; i < body.lyrics.length; i++) {
        var ln = body.lyrics[i];
        if (!ln || typeof ln.time !== "number") continue;
        var text = (typeof ln.text === "string") ? ln.text.replace(/\s+/g, " ").trim() : "";
        if (text === "") continue;
        out.push(msToLrcTime(ln.time) + text);
    }
    return out.length > 0 ? out.join("\n") : null;
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
                var lrc = lyricsPlusToLrc(body);
                if (lrc) { cb(lrc); return; }
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
// Logic adapted from ViMusic / ArchiveTune.

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
        cb(text ? kugouStripCredits(text) : null);
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
        kugouDownload(ctx, cand.id, cand.accesskey, function (lrc) {
            if (ctx.isStale()) return;
            if (lrc) { cb(lrc); return; }
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
// is best-effort: YouTube gates some networks (datacenter IPs) entirely.
// 1. InnerTube search on music.youtube.com (WEB_REMIX) -> first videoId.
// 2. InnerTube player, ANDROID first (still returns ungated caption baseUrls
//    on most networks), then WEB_REMIX, then the watch page.
// 3. timedtext fmt=json3 -> LRC.

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
            cb(json3ToLrc(resp2));
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
        function (lrc) {
            if (ctx.isStale() || lrc) { cb(lrc); return; }
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

var PROVIDERS = [
    { id: "betterlyrics", name: "Better Lyrics", fetch: fetchBetterLyrics },
    { id: "unison", name: "Unison", fetch: fetchUnison },
    { id: "lyricsplus", name: "LyricsPlus", fetch: fetchLyricsPlus },
    { id: "kugou", name: "KuGou", fetch: fetchKugou },
    { id: "youtube", name: "YouTube Music", fetch: fetchYoutubeMusic }
];

function getProvider(id) {
    for (var i = 0; i < PROVIDERS.length; i++)
        if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return null;
}

// Tries every enabled provider in order, calls cb(lrc) with the first match
// or cb(null) when all of them miss.
function fetchAll(ctx, cb) {
    var chain = [];
    var enabled = ctx.enabled || [];
    for (var i = 0; i < PROVIDERS.length; i++)
        if (enabled.indexOf(PROVIDERS[i].id) !== -1) chain.push(PROVIDERS[i]);
    if (chain.length === 0) { cb(null); return; }

    var idx = -1;
    function next() {
        idx += 1;
        if (idx >= chain.length) { cb(null); return; }
        if (ctx.isStale()) return;
        var p = chain[idx];
        ctx.log("lyrics: trying " + p.name);
        try {
            p.fetch(ctx, function (lrc) {
                if (ctx.isStale()) return;
                if (lrc) {
                    ctx.log("lyrics: found on " + p.name);
                    cb(lrc);
                    return;
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

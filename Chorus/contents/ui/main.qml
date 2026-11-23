import QtQuick
import QtQuick.Window
import QtQuick.Layouts
import QtQuick.Effects
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.components as PC3
import org.kde.kirigami as Kirigami
import org.kde.plasma.private.mpris as Mpris
import org.kde.plasma.plasma5support as P5Support
import "../code/lrc.js" as Lrc
import "../code/providers.js" as Providers

PlasmoidItem {
    id: root

    preferredRepresentation: compactRepresentation
    Mpris.Mpris2Model { id: mpris }

    Instantiator {
        id: playerScan
        model: mpris
        delegate: QtObject {
            readonly property int idx: index
            readonly property string matchText:
                (String(model.identity || "") + " " + (String(model.desktopEntry || ""))).toLowerCase()
            readonly property bool matches: root.matchesFilter(matchText)
            function claim() {
                if (matches && !root.playerMatches && mpris.currentIndex !== idx)
                    mpris.currentIndex = idx;
            }
            onMatchesChanged: claim()
            onMatchTextChanged: root.playersRevision++
            Component.onCompleted: { root.playersRevision++; claim(); }
            Component.onDestruction: root.playersRevision++
            readonly property Connections conn: Connections {
                target: root
                function onPlayerMatchesChanged() { if (!root.playerMatches) claim(); }
            }
        }
    }

    property int playersRevision: 0
    function appRunning(token) {
        if (!token) return false;
        var rev = playersRevision;
        for (var i = 0; i < playerScan.count; i++) {
            var o = playerScan.objectAt(i);
            if (o && o.matchText.indexOf(token) !== -1) return true;
        }
        return false;
    }
    function currentPlayerIs(token) {
        if (!token || !player) return false;
        return ((player.identity || "") + " " + (player.desktopEntry || ""))
               .toLowerCase().indexOf(token) !== -1;
    }

    readonly property var player: mpris.currentPlayer
    readonly property var cfgMatchList: {
        var mode = Plasmoid.configuration.appMode;
        if (mode !== "custom") return [];
        var parts = (Plasmoid.configuration.playerMatch || "").toLowerCase().split(",");
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var t = parts[i].trim();
            if (t !== "") out.push(t);
        }
        return out;
    }
    function matchesFilter(text) {
        if (cfgMatchList.length === 0) return true;
        for (var i = 0; i < cfgMatchList.length; i++)
            if (text.indexOf(cfgMatchList[i]) !== -1) return true;
        return false;
    }
    readonly property bool playerMatches: {
        if (!player) return false;
        return matchesFilter(((player.identity || "") + " " + (player.desktopEntry || "")).toLowerCase());
    }
    readonly property bool isPlaying: playerMatches && player.playbackStatus === Mpris.PlaybackStatus.Playing
    readonly property bool isPaused:  playerMatches && player.playbackStatus === Mpris.PlaybackStatus.Paused
    readonly property bool isActive:  isPlaying || isPaused
    readonly property bool hasTrack:  playerMatches && trackTitle !== ""

    property var optimistic: null
    Timer {
        id: optimisticTimeout
        interval: 12000
        repeat: false
        onTriggered: root.optimistic = null
    }
    Timer {
        id: optSettle
        interval: 1500
        repeat: false
        onTriggered: {
            if (root.optimistic === null) return;
            var want = (root.optimistic.title || "").trim().toLowerCase();
            var have = root.trackTitle.trim().toLowerCase();
            if (root.isPlaying && have !== "" && have === want) root.optimistic = null;
            else restart();
        }
    }

    readonly property string rawTitle:  playerMatches && player.track  ? player.track  : ""
    readonly property string rawArtist: playerMatches && player.artist ? player.artist : ""
    readonly property string rawAlbum:  playerMatches && player.album  ? player.album  : ""
    readonly property url    rawArt:    playerMatches && player.artUrl ? player.artUrl : ""

    property var heldTrack: null
    property string snapTitle: ""
    property string snapArtist: ""
    property string snapAlbum: ""
    property url snapArt: ""
    Timer {
        id: metaHold
        interval: 500
        repeat: false
        onTriggered: {
            root.heldTrack = null;
            root.metaGate();
        }
    }
    onRawTitleChanged:  metaGate()
    onRawArtistChanged: metaGate()
    onRawAlbumChanged:  metaGate()
    onRawArtChanged:    metaGate()
    function metaGate() {
        if (heldTrack !== null) {
            if (rawTitle !== heldTrack.title && rawLengthMs <= 0) return;
            heldTrack = null;
            metaHold.stop();
        } else if (snapTitle !== "" && rawTitle !== "" && rawTitle !== snapTitle
                   && isPlaying && rawLengthMs <= 0 && stickyLengthMs > 0) {
            heldTrack = { title: snapTitle, artist: snapArtist, album: snapAlbum, art: snapArt };
            metaHold.restart();
            console.log("[chorus] metadata without a length arrived mid-track (\"" + rawTitle
                        + "\"), holding \"" + snapTitle + "\" for now");
            return;
        }
        snapTitle = rawTitle;
        snapArtist = rawArtist;
        snapAlbum = rawAlbum;
        snapArt = rawArt;
    }

    readonly property string trackTitle:  heldTrack ? heldTrack.title  : rawTitle
    readonly property string trackArtist: heldTrack ? heldTrack.artist : rawArtist
    readonly property string trackAlbum:  heldTrack ? heldTrack.album  : rawAlbum
    readonly property url    artUrl:      heldTrack ? heldTrack.art    : rawArt
    readonly property string dispTitle:  optimistic ? optimistic.title  : trackTitle
    readonly property string dispArtist: optimistic ? optimistic.artist : trackArtist
    readonly property url    dispArt:    (optimistic && optimistic.art !== "") ? optimistic.art : artUrl
    readonly property double rawLengthMs: playerMatches && player.length ? player.length / 1000 : 0
    property double stickyLengthMs: 0
    readonly property double lengthMs: rawLengthMs > 0 ? rawLengthMs : stickyLengthMs
    onRawLengthMsChanged: {
        if (rawLengthMs > 0) stickyLengthMs = rawLengthMs;
        metaGate();
        safeCall(["updatePosition"]);
    }
    readonly property double playRate:    (playerMatches && player.rate && player.rate > 0) ? player.rate : 1.0
    readonly property bool winVisible: Window.visibility !== Window.Hidden && Window.visibility !== 0

    property double posMs: 0
    property double posStamp: 0
    readonly property int lyricsOffsetMs: {
        var v = Number(Plasmoid.configuration.lyricsOffsetMs);
        return isNaN(v) ? 0 : v;
    }

    function rawNowMs() {
        return isPlaying ? posMs + (Date.now() - posStamp) * playRate : posMs;
    }
    function nowMs() { return rawNowMs() + lyricsOffsetMs; }

    property double lastReported: -1
    property double seekStamp: 0
    property double backProbeVal: -1
    property double backProbeAt: 0
    property int badReports: 0
    readonly property bool trustPos: badReports < 3
    Timer {
        id: posRecheck
        interval: 900
        repeat: false
        onTriggered: root.safeCall(["updatePosition"])
    }
    function startCalibration() {
        lastReported = -1;
        calibTimer.ticks = 0;
    }
    Timer {
        id: calibTimer
        interval: 150
        repeat: true
        property int ticks: 999
        running: root.isPlaying && root.winVisible && root.haveSynced && root.trustPos && ticks < 14
        onTriggered: {
            ticks++;
            root.safeCall(["updatePosition"]);
        }
    }

    Connections {
        target: root.player
        enabled: root.player !== null
        function onPositionChanged() {
            if (!root.trustPos) return;
            var reported = root.player.position / 1000;
            var predicted = root.rawNowMs();
            var diff = reported - predicted;
            if (root.seekStamp > 0) {
                var since = Date.now() - root.seekStamp;
                if (since < 2500) {
                    if (Math.abs(diff) > 1000) {
                        posRecheck.restart();
                        return;
                    }
                }
                root.seekStamp = 0;
            }
            if (root.isPlaying && calibTimer.ticks < 15 && Math.abs(diff) < 2000) {
                if (root.lastReported >= 0 && reported > root.lastReported
                        && reported - root.lastReported < 2000) {
                    root.posMs = reported;
                    root.posStamp = Date.now();
                    root.uiPosMs = root.nowMs();
                    calibTimer.ticks = 999;
                    root.lastReported = reported;
                    root.resync();
                    return;
                }
                root.lastReported = reported;
                return;
            }
            root.lastReported = reported;
            if (root.isPlaying && Math.abs(diff) < 750) {
                return;
            }
            if (root.isPlaying && diff < -2000 && reported < 2000 && predicted > 3000) {
                if (root.backProbeVal >= 0 && Date.now() - root.backProbeAt > 600) {
                    var waited = (Date.now() - root.backProbeAt) * root.playRate;
                    var moved = reported - root.backProbeVal;
                    root.backProbeVal = -1;
                    if (moved < waited * 0.5) {
                        root.badReports++;
                        console.log("[chorus] player reports a stuck position near 0 ("
                                    + Math.round(reported) + "ms while playing "
                                    + Math.round(predicted) + "ms), keeping the local clock"
                                    + (root.trustPos ? "" : "; ignoring its position reports for this track"));
                        return;
                    }
                } else {
                    root.backProbeVal = reported;
                    root.backProbeAt = Date.now();
                    posRecheck.restart();
                    return;
                }
            } else {
                root.backProbeVal = -1;
            }
            root.badReports = 0;
            root.posMs = reported;
            root.posStamp = Date.now();
            root.uiPosMs = root.nowMs();
            root.resync();
            if (root.isPlaying) root.startCalibration();
        }
    }

    property var lines: []
    readonly property bool haveSynced: lines.length > 0
    readonly property bool wordsAnimEnabled: Plasmoid.configuration.wordAnimation !== false
    property bool wordSync: false
    property int lineIdx: -1
    // The line the transcript view has moved to ahead of playback (DMS followIndex).
    property int followIdx: -1
    property string songSource: ""
    property bool songInstrumental: false
    property double curStart: 0
    property double curEnd: 0
    property double uiPosMs: 0
    property var cache: ({})
    property var cacheKeys: []
    property bool fetching: false

    // Transcript items for the popup: lyric lines plus instrumental breaks
    // (DMS LyricsModel.buildItems; a gap longer than 5 s becomes a break).
    readonly property var lyricItems: haveSynced ? Lrc.buildItems(lines, 5000) : []

    // Word fragments of a line, or null when the line (or the config) has no
    // word-level timings to sweep.
    function lineWords(i) {
        if (!wordsAnimEnabled || i < 0 || i >= lines.length) return null;
        var w = lines[i].words;
        return (w && w.length > 1) ? w : null;
    }

    signal lyricsResynced()

    readonly property string songKey: trackTitle + "\u0001" + trackArtist
    onSongKeyChanged: {
        fetching = false;
        badReports = 0;
        backProbeVal = -1;
        stickyLengthMs = rawLengthMs > 0 ? rawLengthMs : 0;
        if (trackTitle !== "") { optimistic = null; optimisticTimeout.stop(); }
        lines = [];
        lineIdx = -1;
        followIdx = -1;
        songSource = "";
        songInstrumental = false;
        if (trackTitle !== "") {
            posMs = 0;
            posStamp = Date.now();
            uiPosMs = 0;
            seekStamp = 0;
            fetchLyrics();
            startCalibration();
            safeCall(["updatePosition"]);
        } else {
            posMs = 0;
            uiPosMs = 0;
        }
    }

    function httpGet(url, cb, headers) {
        var xhr = new XMLHttpRequest();
        var done = false;
        function finish(ok, body) {
            if (done)
                return;
            done = true;
            cb(ok, body);
        }
        xhr.onreadystatechange = function () {
            if (xhr.readyState === XMLHttpRequest.DONE)
                finish(xhr.status === 200, xhr.responseText);
        };
        xhr.timeout = 10000;
        xhr.ontimeout = function () { finish(false, ""); };
        xhr.open("GET", url);
        if (headers) {
            for (var h in headers) xhr.setRequestHeader(h, headers[h]);
        } else {
            xhr.setRequestHeader("Lrclib-Client", "Chorus/1.0 (Plasma widget)");
        }
        xhr.send();
    }

    function httpPostJson(url, body, cb) {
        var xhr = new XMLHttpRequest();
        var done = false;
        function finish(ok, resp) {
            if (done)
                return;
            done = true;
            cb(ok, resp);
        }
        xhr.onreadystatechange = function () {
            if (xhr.readyState === XMLHttpRequest.DONE)
                finish(xhr.status === 200, xhr.responseText);
        };
        xhr.timeout = 10000;
        xhr.ontimeout = function () { finish(false, ""); };
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(body);
    }

    function rememberCache(key, val) {
        if (cache[key] === undefined) {
            cacheKeys.push(key);
            if (cacheKeys.length > 80) {
                var old = cacheKeys.shift();
                delete cache[old];
            }
        }
        cache[key] = val;
    }

    // One-shot JS callback on a throwaway QML Timer (QML has no setTimeout).
    function later(ms, fn) {
        var t = Qt.createQmlObject("import QtQuick; Timer { }", root, "chorusLaterTimer");
        t.interval = Math.max(1, ms);
        t.triggered.connect(function () { t.destroy(); fn(); });
        t.start();
    }

    // Fetch like DMS: every enabled provider is raced at once and the best
    // answer wins (see providers.js fetchAll / dmsPick). Priority order is
    // DMS's builtin order: Better Lyrics, Unison, LyricsPlus, KuGou, LRCLIB,
    // YouTube Music.
    function fetchLyrics() {
        var key = songKey;
        if (cache[key] !== undefined) {
            applyLyrics(cache[key]);
            return;
        }
        fetching = true;
        var durS = Math.round(lengthMs / 1000);
        var ctx = {
            title: trackTitle,
            artist: trackArtist,
            album: trackAlbum,
            durS: durS,
            enabled: Plasmoid.configuration.extraProviders || [],
            later: root.later,
            httpGet: httpGet,
            httpPostJson: httpPostJson,
            isStale: function () { return root.songKey !== key; },
            log: function (msg) { console.log("[chorus] " + msg); }
        };
        Providers.fetchAll(ctx, function (song) {
            if (root.songKey !== key) return;
            root.fetching = false;
            if (song) {
                root.rememberCache(key, song);
                root.applyLyrics(song);
            } else {
                root.applyLyrics(null);
            }
        });
    }

    function applyLyrics(song) {
        if (song && song.lines) {
            lines = song.lines;
            wordSync = song.wordSync === true;
            songSource = song.providerName || "";
            songInstrumental = song.instrumental === true;
            // DMS: a line moves into the centre over a share of the time since
            // the line before it, so the view paces itself to the song
            for (var i = 0; i < lines.length; i++) {
                var since = i > 0 ? lines[i].t - lines[i - 1].t : Number.POSITIVE_INFINITY;
                lines[i].move = Math.max(400, Math.min(1000, since * 0.3));
            }
        } else {
            lines = [];
            wordSync = false;
            songSource = "";
            songInstrumental = false;
        }
        resync();
    }

    function resync() {
        uiPosMs = nowMs();
        if (!haveSynced) {
            lineIdx = -1;
            lineTimer.stop();
            lyricsResynced();
            return;
        }
        var t = nowMs();
        var idx = Lrc.indexFor(lines, t);
        curStart = idx >= 0 ? lines[idx].t : 0;
        // prefer the line's own end time when the source provides one
        curEnd = (idx >= 0 && lines[idx].e > curStart) ? lines[idx].e
               : (idx + 1 < lines.length) ? lines[idx + 1].t
                                          : Math.max(curStart + 5000, lengthMs);
        if (curEnd <= curStart) curEnd = curStart + 1000;
        lineIdx = idx;
        // DMS followIndex: the view moves to the next line a little before it
        // starts, so the line is centred when it is sung. leadIn = 0.4 * move.
        if (idx + 1 < lines.length) {
            var nx = lines[idx + 1];
            var leadIn = nx.t - (nx.move || 500) * 0.4;
            followIdx = t >= leadIn ? idx + 1 : idx;
        } else {
            followIdx = idx;
        }
        lineTimer.stop();
        if (isPlaying && winVisible && idx + 1 < lines.length) {
            lineTimer.interval = Math.max(30, (lines[idx + 1].t - t) / playRate);
            lineTimer.start();
        }
        lyricsResynced();
    }

    Timer {
        id: lineTimer
        repeat: false
        onTriggered: root.resync()
    }

    Timer {
        id: driftTimer
        interval: 3000
        repeat: true
        running: root.isPlaying && root.winVisible && root.haveSynced && root.trustPos
        onTriggered: root.safeCall(["updatePosition"])
    }

    onWinVisibleChanged: {
        if (winVisible && isActive) {
            safeCall(["updatePosition"]);
            resync();
        } else {
            lineTimer.stop();
        }
    }
    onIsPlayingChanged: {
        if (!isPlaying) {
            posMs = posMs + (Date.now() - posStamp) * playRate;
        }
        posStamp = Date.now();
        safeCall(["updatePosition"]);
        resync();
    }

    function safeCall(names, arg) {
        if (!player) return false;
        for (var i = 0; i < names.length; i++) {
            var n = names[i];
            try {
                if (typeof player[n] === "function") {
                    arg === undefined ? player[n]() : player[n](arg);
                    return true;
                }
            } catch (e) {}
        }
        return false;
    }
    function doPlayPause() { safeCall(["PlayPause", "playPause"]); }
    function doNext()      { safeCall(["Next", "next"]); }
    function doPrev()      { safeCall(["Previous", "previous"]); }
    function doRaise() {
        safeCall(["Raise", "raise"]);
        if (pearIsCurrent || (pear !== null && !player)) pear.launchApp();
    }
    property bool volumeWorks: true
    property double volProbeTarget: -1
    property var volBroken: ({})
    readonly property bool canSetVolume: playerMatches && player.volume !== undefined && volumeWorks
    function volKeyFor(p) {
        if (!p) return "";
        return String(p.identity || "") + "|" + String(p.desktopEntry || "");
    }
    onPlayerChanged: {
        volProbe.stop();
        volProbeTarget = -1;
        volumeWorks = volBroken[volKeyFor(player)] !== true;
        badReports = 0;
        backProbeVal = -1;
        heldTrack = null;
        metaHold.stop();
        stickyLengthMs = 0;
        pendingSeekUs = -1;
        seekWrite.stop();
        metaGate();
    }
    Timer {
        id: volProbe
        interval: 900
        repeat: false
        onTriggered: {
            if (!root.player || root.volProbeTarget < 0) return;
            var cur = root.player.volume;
            root.volumeWorks = cur !== undefined && Math.abs(cur - root.volProbeTarget) < 0.02;
            root.volProbeTarget = -1;
            if (!root.volumeWorks) {
                root.volBroken[root.volKeyFor(root.player)] = true;
                console.log("[chorus] " + (root.player.identity || "player")
                            + " ignores volume writes, disabling volume control for it");
            }
        }
    }

    function setVol01(v) {
        if (!player || !volumeWorks) return;
        v = Math.max(0, Math.min(1, v));
        volProbeTarget = v;
        volProbe.restart();
        try {
            player.volume = v;
        } catch (e) {
            volProbe.stop();
            volProbeTarget = -1;
            volumeWorks = false;
            volBroken[volKeyFor(player)] = true;
        }
    }
    function changeVol(deltaPct) {
        if (!canSetVolume) return;
        var curPct = Math.round((player.volume || 0) * 100);
        var snapped = Math.round(curPct / 5) * 5;
        setVol01(Math.max(0, Math.min(100, snapped + deltaPct)) / 100);
    }
    property double pendingSeekUs: -1
    Timer {
        id: seekWrite
        interval: 100
        repeat: false
        onTriggered: {
            var us = root.pendingSeekUs;
            root.pendingSeekUs = -1;
            if (us < 0 || !root.player) return;
            var ok = true;
            try { root.player.position = us; } catch (e) { ok = false; }
            if (!ok) root.safeCall(["Seek", "seek"], us - Math.round(root.rawNowMs() * 1000));
        }
    }
    function seekToMs(ms) {
        if (!player || !player.canSeek) return;
        var target = Math.max(0, lengthMs > 0 ? Math.min(ms, lengthMs) : ms);
        pendingSeekUs = Math.round(target * 1000);
        seekWrite.restart();
        seekStamp = Date.now();
        posMs = target;
        posStamp = Date.now();
        uiPosMs = nowMs();
        resync();
        if (isPlaying) startCalibration();
    }

    readonly property string searchMode: {
        var m = Plasmoid.configuration.searchMode;
        if (m === "pear" || m === "spotify" || m === "none" || m === "auto") return m;
        var legacy = Plasmoid.configuration.appMode;
        return (legacy === "pear" || legacy === "spotify") ? legacy : "none";
    }
    property string autoLastProvider: "none"
    readonly property string searchProvider: {
        if (searchMode !== "auto") return searchMode;
        var spotifyUsable = (Plasmoid.configuration.spotifyClientId || "").trim() !== ""
                         && (Plasmoid.configuration.spotifyClientSecret || "").trim() !== "";
        if (spotifyUsable && currentPlayerIs("spotify")) return "spotify";
        if (currentPlayerIs("youtube")) return "pear";
        if (player && isActive) return "none";
        if (spotifyUsable && appRunning("spotify")) return "spotify";
        if (appRunning("youtube")) return "pear";
        return autoLastProvider;
    }
    onSearchProviderChanged: {
        if (searchMode === "auto"
                && (searchProvider === "pear" || searchProvider === "spotify"))
            autoLastProvider = searchProvider;
    }

    readonly property string searchAppToken:
        searchProvider === "pear" ? "youtube" : searchProvider === "spotify" ? "spotify" : ""
    readonly property bool searchAppRunning: appRunning(searchAppToken)
    readonly property string searchAppName:
        searchProvider === "pear" ? i18n("YouTube Music") : searchProvider === "spotify" ? i18n("Spotify") : ""
    readonly property var searchApi: pear !== null ? pear : spotifyApi
    readonly property bool showAppButton: searchApi !== null && !(searchProvider === "pear"
        ? Plasmoid.configuration.pearHideAppButton
        : Plasmoid.configuration.spotifyHideAppButton)

    readonly property bool pearMode: searchProvider === "pear"
    Loader {
        id: pearLoader
        active: root.pearMode
        source: "pear/PearApi.qml"
    }
    readonly property var pear: pearLoader.item
    readonly property bool pearIsCurrent: pear !== null && playerMatches
                                          && currentPlayerIs("youtube")
    readonly property bool spotifyMode: searchProvider === "spotify"
    Loader {
        id: spotifyApiLoader
        active: root.spotifyMode
        source: "spotify/SpotifyApi.qml"
    }

    readonly property var spotifyApi: spotifyApiLoader.item

    function showOptimistic(o) { optimistic = o; optimisticTimeout.restart(); }
    function settleOptimistic() { optSettle.restart(); }
    function runCmd(sh) { exec.connectSource(sh); }
    property var cmdCallbacks: ({})
    function runCmdWatch(sh, cb) { cmdCallbacks[sh] = cb; exec.connectSource(sh); }

    readonly property bool shuffleOn: pearIsCurrent ? pear.shuffleOn : false
    readonly property string repeatMode: pearIsCurrent ? pear.repeatMode : "NONE"
    function doShuffle() {
        if (pearIsCurrent) pear.doShuffle();
        else mprisShuffle();
    }

    function doLoop() {
        if (pearIsCurrent) pear.doLoop();
        else mprisLoop();
    }

    function mprisShuffle() {
        if (!player) return;
        try {
            player.shuffle = (player.shuffle === Mpris.ShuffleStatus.On)
                           ? Mpris.ShuffleStatus.Off : Mpris.ShuffleStatus.On;
        } catch (e) {}
    }

    function mprisLoop() {
        if (!player) return;
        var cur = player.loopStatus;
        var next = cur === Mpris.LoopStatus.Playlist ? Mpris.LoopStatus.Track
                 : cur === Mpris.LoopStatus.Track ? Mpris.LoopStatus.None
                 : Mpris.LoopStatus.Playlist;
        try { player.loopStatus = next; } catch (e) {}
    }
    readonly property bool canShuffle: pearIsCurrent
        || (playerMatches && player.shuffle !== Mpris.ShuffleStatus.Unknown)
    readonly property bool canLoop: pearIsCurrent
        || (playerMatches && player.loopStatus !== Mpris.LoopStatus.Unknown)

    P5Support.DataSource {
        id: exec
        engine: "executable"
        connectedSources: []
        onNewData: function (sourceName, data) {
            disconnectSource(sourceName);
            var cb = root.cmdCallbacks[sourceName];
            if (cb) {
                delete root.cmdCallbacks[sourceName];
                cb(data["stdout"] || "");
            }
        }
    }

    property string lastAppliedMode: ""
    function applyPanelMode(idle) {
        if (!Plasmoid.configuration.managePanel) return;
        var mode = idle ? Plasmoid.configuration.idleMode : Plasmoid.configuration.activeMode;
        if (["autohide", "dodgewindows", "windowsgobelow", "normal"].indexOf(mode) === -1) return;
        if (mode === lastAppliedMode || mode === "") return;
        lastAppliedMode = mode;
        var script = 'panels().forEach(function(p){var ws=p.widgets();for(var i=0;i<ws.length;i++){if(ws[i].type=="' + Plasmoid.metaData.pluginId + '"){p.hiding="' + mode + '";}}});';
        exec.connectSource("gdbus call --session --dest org.kde.plasmashell --object-path /PlasmaShell --method org.kde.PlasmaShell.evaluateScript '" + script + "'");
    }

    Timer {
        id: idleDebounce
        interval: 4000
        repeat: false
        onTriggered: root.applyPanelMode(true)
    }
    onIsActiveChanged: {
        if (isActive) {
            idleDebounce.stop();
            applyPanelMode(false);
        } else {
            idleDebounce.restart();
        }
    }
    Component.onCompleted: {
        if (isActive) applyPanelMode(false);
        else idleDebounce.restart();
    }

    Plasmoid.status: isActive ? PlasmaCore.Types.ActiveStatus : PlasmaCore.Types.PassiveStatus
    Plasmoid.backgroundHints: PlasmaCore.Types.ShadowBackground | PlasmaCore.Types.ConfigurableBackground
    toolTipMainText: ""
    toolTipSubText: ""
    toolTipTextFormat: Text.PlainText
    hideOnWindowDeactivate: true

    readonly property var fontSources: {
        if (!Plasmoid.configuration.useCustomFont) return [];
        var out = [];
        var all = [String(Plasmoid.configuration.fontPath || "")]
            .concat(Plasmoid.configuration.fontFallbacks || []);
        for (var i = 0; i < all.length; i++) {
            var p = String(all[i] || "").trim();
            if (p !== "" && out.indexOf(p) < 0) out.push(p);
        }
        return out;
    }

    Instantiator {
        id: fontLoaders
        model: root.fontSources
        delegate: FontLoader {
            source: modelData.indexOf("file:") === 0 ? modelData : "file://" + modelData
            onStatusChanged: root.syncFontFamilies()
        }
        onObjectAdded: root.syncFontFamilies()
        onObjectRemoved: root.syncFontFamilies()
    }

    property var loadedFamilies: []
    function syncFontFamilies() {
        var out = [];
        for (var i = 0; i < fontLoaders.count; i++) {
            var l = fontLoaders.objectAt(i);
            if (l && l.status === FontLoader.Ready && l.name !== "" && out.indexOf(l.name) < 0)
                out.push(l.name);
        }
        loadedFamilies = out;
    }

    readonly property string cfgFont: loadedFamilies.length > 0
        ? loadedFamilies[0]
        : Kirigami.Theme.defaultFont.family
    readonly property string cfgFontCss: {
        if (loadedFamilies.length < 2) return "";
        var out = [];
        var all = loadedFamilies.concat([Kirigami.Theme.defaultFont.family]);
        for (var i = 0; i < all.length; i++) {
            var f = String(all[i]).replace(/["'\\<>;{}]/g, "").trim();
            if (f !== "") out.push("'" + f + "'");
        }
        return out.join(", ");
    }
    readonly property color cActive: Plasmoid.configuration.activeColor
    readonly property color cInactive: Qt.alpha(cActive, 0.55)

    // One lyric line: a plain Text when the line has no word timings, otherwise
    // a row of timed fragments that light up with the active color as they are
    // sung — a karaoke sweep like the Dux Lyrical Engine (DMS 2.0) / Apple
    // Music. The fill edge per frame comes from Lrc.smoothEdge.
    component LyricLineView: Item {
        id: lineView

        property string text: ""
        property var words: null            // [{ t, e, text }] | null
        property bool sweep: true           // word animation enabled
        property bool playing: false        // drives the per-frame sweep clock
        property color textColor: root.cActive
        property real fontPx: 14
        property int fontWeight: Font.DemiBold
        property bool elidePlain: false     // clip long plain lines with "..."
        property bool shrinkToFit: false    // scale a long word row down to fit

        readonly property bool hasWords: sweep && fragRepeater.count > 1

        implicitWidth: hasWords ? fragRow.width : plainText.implicitWidth
        width: implicitWidth
        height: fontPx * 1.7
        onWordsChanged: rebuild()
        onHasWordsChanged: updateFills()
        onPlayingChanged: updateFills()
        Component.onCompleted: rebuild()

        function rebuild() {
            var frags = [];
            if (words) {
                for (var i = 0; i < words.length; i++) {
                    var w = words[i];
                    if (!w || typeof w.t !== "number" || w.t < 0) continue;
                    frags.push({ t: w.t,
                                 e: (typeof w.e === "number" && w.e > w.t) ? w.e : w.t,
                                 text: String(w.text) });
                }
            }
            if (frags.length < 2) frags = [];
            fragRepeater.model = frags;
            updateFills();
        }

        function updateFills() {
            if (!hasWords) return;
            var segs = [], i;
            for (i = 0; i < fragRepeater.count; i++) {
                var it = fragRepeater.itemAt(i);
                if (!it) continue;
                segs.push({ t: it.t, e: it.e, x0: it.x, x1: it.x + it.width });
            }
            if (segs.length === 0) return;
            var edge = Lrc.smoothEdge(segs, root.nowMs(), fontPx * 0.9, 240);
            for (i = 0; i < fragRepeater.count; i++) {
                var d = fragRepeater.itemAt(i);
                if (d) d.fillW = Math.max(0, Math.min(d.width, edge - d.x));
            }
        }

        FrameAnimation {
            id: sweepAnim
            running: lineView.hasWords && lineView.playing
                     && root.winVisible && lineView.visible
            onTriggered: lineView.updateFills()
        }

        Text {
            id: plainText
            textFormat: root.cfgFontCss !== "" ? Text.RichText : Text.PlainText
            visible: !lineView.hasWords
            text: lineView.hasWords ? "" : Lrc.fontSpan(lineView.text, root.cfgFontCss)
            width: lineView.elidePlain ? lineView.width : implicitWidth
            elide: lineView.elidePlain ? Text.ElideRight : Text.ElideNone
            anchors.verticalCenter: parent.verticalCenter
            color: lineView.textColor
            font.family: root.cfgFont
            font.pixelSize: lineView.fontPx
            font.weight: lineView.fontWeight
        }

        Row {
            id: fragRow
            visible: lineView.hasWords
            anchors.verticalCenter: parent.verticalCenter
            scale: lineView.shrinkToFit && lineView.width > 0
                   ? Math.min(1, lineView.width / fragRow.implicitWidth) : 1
            transformOrigin: Item.Left

            Repeater {
                id: fragRepeater

                delegate: Item {
                    id: frag

                    required property var modelData
                    readonly property real t: modelData.t
                    readonly property real e: modelData.e
                    property real fillW: 0

                    width: fragBase.implicitWidth
                    height: lineView.height

                    Text {
                        id: fragBase
                        textFormat: root.cfgFontCss !== "" ? Text.RichText : Text.PlainText
                        y: (parent.height - implicitHeight) / 2
                        text: Lrc.fontSpan(frag.modelData.text, root.cfgFontCss)
                        color: root.cInactive
                        font.family: root.cfgFont
                        font.pixelSize: lineView.fontPx
                        font.weight: lineView.fontWeight
                    }

                    // the sung part, clipped to the sweep edge
                    Item {
                        id: fillClip
                        x: 0
                        y: 0
                        width: frag.fillW
                        height: parent.height
                        clip: true

                        Text {
                            id: fragFill
                            textFormat: root.cfgFontCss !== "" ? Text.RichText : Text.PlainText
                            y: fragBase.y
                            text: Lrc.fontSpan(frag.modelData.text, root.cfgFontCss)
                            color: root.cActive
                            font.family: root.cfgFont
                            font.pixelSize: lineView.fontPx
                            font.weight: lineView.fontWeight
                        }
                    }
                }
            }
        }
    }

    // DMS 2.0 transcript pieces. One wrapped row of a lyric line: dim glyphs
    // plus a clipped accent copy whose width is the karaoke sweep edge (DMS
    // draws this through a shader; a clip keeps the widget light). Rows without
    // word timings fill at once when the line starts, like DMS's line-timed
    // parts.
    component LyricFace: Item {
        id: face

        property string text: ""
        property var segments: []           // [{ t, e, x0, x1 }] in px
        property bool sweepable: false      // true when the fragments carry real word times
        property real fontPx: 14
        property int fontWeight: Font.DemiBold
        property color dimColor: root.cInactive
        property color fillColor: root.cActive
        property real clock: -1             // ms; 1e12 = fully sung, -1 = unsung

        readonly property real lead: fontPx * 0.9
        readonly property real edgeFrac: {
            if (!segments || segments.length === 0) return 0;
            var last = segments[segments.length - 1].x1;
            if (!(last > 0)) return 0;
            var e = sweepable ? Lrc.smoothEdge(segments, clock, lead, 240)
                              : Lrc.fillEdge(segments, clock, false, 0);
            return Math.max(0, Math.min(1, e / last));
        }

        width: glyphText.implicitWidth
        height: Math.ceil(fontPx * 1.45)

        Text {
            id: glyphText
            textFormat: root.cfgFontCss !== "" ? Text.RichText : Text.PlainText
            anchors.verticalCenter: parent.verticalCenter
            text: Lrc.fontSpan(face.text, root.cfgFontCss)
            color: face.dimColor
            font.family: root.cfgFont
            font.pixelSize: face.fontPx
            font.weight: face.fontWeight
        }
        Item {
            width: glyphText.implicitWidth * face.edgeFrac
            height: parent.height
            clip: true
            Text {
                textFormat: root.cfgFontCss !== "" ? Text.RichText : Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: Lrc.fontSpan(face.text, root.cfgFontCss)
                color: face.fillColor
                font.family: root.cfgFont
                font.pixelSize: face.fontPx
                font.weight: face.fontWeight
            }
        }
    }

    // DMS LyricsLine port: one transcript row. The promoted row is the accent
    // colour, big and bold, sweeping word by word; every other row rests small
    // and dim. Instrumental gaps render as a note glyph. A click seeks here.
    component LyricRow: Item {
        id: rowItem

        required property var modelData
        required property int index
        property var view: null

        readonly property bool isBreak: modelData.kind === "break"
        readonly property var line: isBreak ? null : root.lines[modelData.line]
        readonly property int centre: view ? view.centre : -1
        readonly property real rowClock: view ? view.now : 0
        readonly property bool promoted: centre === index
        readonly property bool live: Math.abs(index - centre) <= 1
        // DMS: rows behind the centre are fully sung, rows ahead rest empty;
        // only the rows around the centre get the real clock
        readonly property real clock: !root.haveSynced ? -1
            : live ? rowClock : (index < centre ? 1e12 : -1)
        readonly property real fontPx: promoted ? (view ? view.leadPx : 16)
                                                : Math.round((view ? view.leadPx : 16) * 0.8)
        readonly property real rowH: Math.ceil(fontPx * 1.45)
        readonly property real pad: Kirigami.Units.smallSpacing
        readonly property bool timed: !isBreak && root.wordsAnimEnabled
                                      && line && line.words && line.words.length > 1
        // While browsing every row rests fully visible, like DMS.
        readonly property real restOpacity: (!view || view.following) ? (promoted ? 1 : 0.4) : 1

        width: view ? view.width : 0
        height: isBreak ? Math.ceil((view ? view.breakSize : 16) + pad * 2)
                        : (rows.length > 0 ? rows.length * rowH : rowH) + pad * 2
        opacity: restOpacity
        Behavior on opacity { NumberAnimation { duration: 220 } }
        onHeightChanged: if (view && index >= 0 && height > 0) view.heightCache[index] = height

        property var rows: []
        function relayout() {
            if (isBreak || width <= 0 || !line || !view) { rows = []; return; }
            measure.font.pixelSize = fontPx;
            measure.font.weight = promoted ? Font.Bold : Font.DemiBold;
            rows = Lrc.partRows({ text: line.text,
                                  words: root.lineWords(modelData.line),
                                  t: line.t, e: line.e },
                                width, function (s) {
                                    measure.text = s;
                                    return measure.advanceWidth;
                                });
        }
        onWidthChanged: relayout()
        onPromotedChanged: relayout()
        onModelDataChanged: relayout()
        Component.onCompleted: relayout()

        TextMetrics {
            id: measure
            font.family: root.cfgFont
        }

        Text {
            visible: rowItem.isBreak
            anchors.centerIn: parent
            text: "♪"
            color: rowItem.promoted ? root.cActive : root.cInactive
            font.family: root.cfgFont
            font.pixelSize: view ? view.breakSize : 16
        }

        Repeater {
            model: rowItem.rows

            delegate: LyricFace {
                required property var modelData
                required property int index

                x: Math.round((rowItem.width - width) / 2)
                y: rowItem.pad + index * rowItem.rowH
                text: modelData.text
                segments: modelData.segments
                sweepable: rowItem.timed
                fontPx: rowItem.fontPx
                fontWeight: rowItem.promoted ? Font.Bold : Font.DemiBold
                dimColor: Qt.alpha(root.cActive, rowItem.promoted ? 0.35 : 0.45)
                fillColor: root.cActive
                clock: rowItem.clock
            }
        }

        MouseArea {
            anchors.fill: parent
            enabled: !rowItem.isBreak && rowItem.line && root.playerMatches
                     && root.player && root.player.canSeek
            cursorShape: Qt.PointingHandCursor
            onClicked: {
                if (rowItem.view) rowItem.view.following = true;
                root.seekToMs(rowItem.line.t);
            }
        }
    }

    // DMS LyricsOverlay port: the popup transcript. The sung item is centred,
    // the view follows with a song-paced scroll, the user can browse freely and
    // a "Follow playback" pill brings the view back. Gaps longer than 5 s are
    // instrumental breaks; the footer credits the lyrics provider.
    component Transcript: Item {
        id: ts

        readonly property var items: root.lyricItems
        readonly property real leadPx: Math.round(Math.max(Kirigami.Units.gridUnit * 1.1,
            Math.min(Kirigami.Units.gridUnit * 1.9, ts.height / 12, ts.width / 11)))
        readonly property real breakSize: Math.round(leadPx * 1.2)
        readonly property real endPadding: Math.max(0, ts.height / 2
            - (ts.leadPx * 1.45 + Kirigami.Units.smallSpacing * 2) / 2)
        property bool following: true
        property int centre: -1
        property real now: 0
        property var heightCache: ({})
        property bool programmatic: false

        Component.onCompleted: {
            ts.now = root.nowMs();
            ts.centre = centreFor(ts.now);
        }

        // the promoted row's sweep needs a per-frame clock
        FrameAnimation {
            running: ts.visible && root.isPlaying && root.haveSynced && ts.following
            onTriggered: ts.now = root.nowMs()
        }

        function centreFor(at) {
            return Lrc.centreItem(ts.items, at, root.followIdx);
        }
        function rowHeightAt(i) {
            if (ts.heightCache[i] !== undefined && ts.heightCache[i] > 0)
                return ts.heightCache[i];
            var it = ts.items[i];
            if (!it) return 0;
            return (it.kind === "break" ? ts.breakSize : Math.round(ts.leadPx * 0.8) * 1.45)
                   + Kirigami.Units.smallSpacing * 2;
        }
        function moveDurFor(c) {
            var it = ts.items[c];
            if (!it || it.kind === "break" || it.line <= 0 || !root.lines[it.line]) return 420;
            return Math.max(400, Math.min(1000, root.lines[it.line].move || 500));
        }
        function targetOffset(c) {
            var y = ts.endPadding;
            for (var i = 0; i < c; i++) y += rowHeightAt(i) + lv.spacing;
            y += rowHeightAt(c) / 2 - ts.height / 2;
            return Math.max(0, y);
        }
        function follow(animate) {
            if (!root.haveSynced || !ts.following || ts.width <= 0) return;
            var target = targetOffset(Math.max(0, ts.centre));
            if (Math.abs(target - lv.contentY) < 1) return;
            scrollAnim.stop();
            if (!animate || Math.abs(target - lv.contentY) > ts.height * 2) {
                ts.programmatic = true;
                lv.contentY = target;
                ts.programmatic = false;
                return;
            }
            scrollAnim.to = target;
            scrollAnim.duration = moveDurFor(ts.centre);
            scrollAnim.restart();
        }
        function browse() {
            if (!ts.following) return;
            ts.following = false;
        }

        onItemsChanged: {
            ts.heightCache = ({});
            ts.following = true;
            ts.now = root.nowMs();
            ts.centre = centreFor(ts.now);
            scrollAnim.stop();
            ts.programmatic = true;
            lv.contentY = 0;
            ts.programmatic = false;
            followTimer.restart();
        }
        onWidthChanged: followTimer.restart()
        onHeightChanged: followTimer.restart()
        onFollowingChanged: if (!ts.following) scrollAnim.stop()

        NumberAnimation {
            id: scrollAnim
            target: lv
            property: "contentY"
            duration: 420
            easing.type: Easing.OutQuint
            onStarted: ts.programmatic = true
            onStopped: ts.programmatic = false
        }
        Timer {
            id: followTimer
            interval: 0
            onTriggered: ts.follow(true)
        }

        Connections {
            target: root
            function onFollowIdxChanged() {
                ts.centre = ts.centreFor(root.nowMs());
                ts.now = root.nowMs();
                followTimer.restart();
            }
            function onLineIdxChanged() {
                ts.centre = ts.centreFor(root.nowMs());
                ts.now = root.nowMs();
                followTimer.restart();
            }
            function onHaveSyncedChanged() { ts.now = root.nowMs(); }
        }

        ListView {
            id: lv
            anchors.fill: parent
            clip: true
            reuseItems: true
            cacheBuffer: Math.max(0, Math.round(ts.height))
            spacing: Kirigami.Units.smallSpacing
            boundsBehavior: Flickable.StopAtBounds
            model: ts.items
            header: Item { width: lv.width; height: ts.endPadding }
            footer: Item {
                width: lv.width
                height: Math.max(ts.endPadding, attrText.implicitHeight + Kirigami.Units.gridUnit)
                Text {
                    id: attrText
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.top: parent.top
                    anchors.topMargin: Kirigami.Units.smallSpacing
                    visible: root.songSource !== ""
                    textFormat: Text.PlainText
                    text: root.songSource
                    color: root.cActive
                    opacity: 0.35
                    font.family: root.cfgFont
                    font.pixelSize: Kirigami.Theme.smallFont.pixelSize
                }
            }
            delegate: LyricRow {
                view: ts
            }
            onContentYChanged: {
                if (!ts.programmatic && !scrollAnim.running) ts.browse();
            }
            onDraggingChanged: if (lv.dragging) ts.browse()
        }
    }

    compactRepresentation: Item {
        id: bar

        property bool activeSticky: false
        Component.onCompleted: {
            activeSticky = root.isActive;
            lineSlide();
        }
        Timer {
            id: idleDelay
            interval: 2500
            repeat: false
            onTriggered: bar.activeSticky = false
        }
        Connections {
            target: root
            function onIsActiveChanged() {
                if (root.isActive) {
                    idleDelay.stop();
                    bar.activeSticky = true;
                } else if (bar.activeSticky) {
                    idleDelay.restart();
                }
            }
        }
        readonly property bool shown: activeSticky || !Plasmoid.configuration.hideWhenIdle
        readonly property bool vertical: Plasmoid.formFactor === PlasmaCore.Types.Vertical
        readonly property real thick: vertical ? width : height
        readonly property real screenLen: vertical ? Screen.height : Screen.width
        readonly property real pad: Kirigami.Units.smallSpacing
        readonly property real coverSize: Math.round(thick * 0.80)
        readonly property real minTotalW: screenLen * Plasmoid.configuration.minFrac
        readonly property real lyricsMaxW: Math.max(80, screenLen * Plasmoid.configuration.maxFrac
                                                    - coverSize - buttonsRow.width - 8 * pad)
        readonly property int lyricPx: Math.max(10, Math.round(thick * 0.46 * Plasmoid.configuration.fontScale))

        // Fixed bar width (barWidthPx, 0 = auto). The lyrics viewport soaks up
        // whatever is left of the fixed width after the cover and buttons.
        readonly property bool fixedW: !vertical && Plasmoid.configuration.barWidthPx > 0
        readonly property real fixedChromeW: (Plasmoid.configuration.showCover ? coverSize : 0)
                + buttonsRow.implicitWidth + 2 + 6 * pad
        readonly property real fixedPx: fixedW
                ? Math.max(220, Plasmoid.configuration.barWidthPx, fixedChromeW + 100)
                : 0

        readonly property real liveLen: shown
            ? (fixedW ? fixedPx : Math.max(row.implicitWidth, minTotalW))
            : 0
        property real frozenLen: 0
        property real frozenViewportW: Number.POSITIVE_INFINITY
        readonly property bool hold: root.expanded || barHover.hovered
        readonly property real contentLen: hold ? Math.max(frozenLen, liveLen) : liveLen
        function captureFrozen() {
            var chromeW = row.implicitWidth - viewport.Layout.preferredWidth;
            var uncappedVw = Math.min(curLine.width + 2, lyricsMaxW);
            frozenLen = shown ? Math.max(chromeW + uncappedVw, minTotalW) : 0;
            frozenViewportW = Math.max(0, frozenLen - chromeW);
        }
        onHoldChanged: {
            if (hold) {
                if (!fixedW) captureFrozen();
            } else {
                frozenLen = 0;
                frozenViewportW = Number.POSITIVE_INFINITY;
            }
        }
        onShownChanged: if (hold && !fixedW) captureFrozen()
        HoverHandler { id: barHover }
        Layout.preferredWidth: vertical ? -1 : contentLen
        Layout.minimumWidth: vertical ? 0 : contentLen
        Layout.maximumWidth: vertical ? Number.POSITIVE_INFINITY : contentLen
        Layout.preferredHeight: vertical ? contentLen : -1
        Layout.minimumHeight: vertical ? contentLen : 0
        Layout.maximumHeight: vertical ? contentLen : Number.POSITIVE_INFINITY
        opacity: shown ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 200 } }

        MouseArea {
            anchors.fill: parent
            onClicked: root.expanded = !root.expanded
            onWheel: function (wheel) {
                if (!root.canSetVolume) return;
                root.changeVol(wheel.angleDelta.y > 0 ? 5 : -5);
                wheel.accepted = true;
            }
        }

        readonly property bool titleMode: root.optimistic !== null || !root.isPlaying || !root.haveSynced
                                          || root.lineIdx < 0 || root.lineIdx >= root.lines.length
        readonly property string displayText: {
            if (root.dispTitle === "") return i18n("Nothing playing");
            if (titleMode)
                return Lrc.normalize(root.dispTitle) + (root.dispArtist ? "  •  " + Lrc.normalize(root.dispArtist) : "");
            var t = root.lines[root.lineIdx].text;
            return t.length ? t : "♪";
        }

        onDisplayTextChanged: {
            lineSlide();
            marquee.reset();
        }
        function lineSlide() {
            slideAnim.stop();
            var animate = shownOnce && displayText !== "" && bar.shown && root.winVisible
                          && !titleMode && root.isPlaying;
            prevLine.text = curLine.text;
            prevLine.words = null;
            curLine.text = displayText;
            curLine.words = titleMode ? null : root.lineWords(root.lineIdx);
            shownOnce = true;
            if (animate && prevLine.text !== "") {
                prevLine.opacity = 1;
                prevLine.y = 0;
                curLine.opacity = 0;
                curLine.y = bar.thick * 0.55;
                slideAnim.start();
            } else {
                prevLine.opacity = 0;
                prevLine.y = 0;
                curLine.opacity = 1;
                curLine.y = 0;
                curLine.updateFills();
            }
        }
        property bool shownOnce: false
        Connections {
            target: root
            function onCfgFontCssChanged() {
                slideAnim.stop();
                prevLine.text = "";
                prevLine.opacity = 0;
                curLine.text = bar.displayText;
                curLine.words = bar.titleMode ? null : root.lineWords(root.lineIdx);
                curLine.opacity = 1;
                curLine.y = 0;
                curLine.rebuild();
            }
            function onLyricsResynced() { curLine.updateFills(); }
        }
        onTitleModeChanged: if (titleMode) {
            slideAnim.stop();
            curLine.words = null;
            curLine.opacity = 1;
            curLine.y = 0;
            prevLine.opacity = 0;
        }

        RowLayout {
            id: row
            width: bar.vertical ? bar.height : bar.width
            height: bar.vertical ? bar.width : bar.height
            anchors.centerIn: parent
            rotation: bar.vertical
                      ? (Plasmoid.location === PlasmaCore.Types.LeftEdge ? -90 : 90)
                      : 0
            spacing: bar.pad

            Item {
                id: coverBox
                visible: Plasmoid.configuration.showCover
                Layout.preferredWidth: bar.coverSize
                Layout.minimumWidth: bar.coverSize
                Layout.preferredHeight: bar.coverSize
                Layout.alignment: Qt.AlignVCenter

                CoverImage {
                    id: coverImg
                    anchors.fill: parent
                    src: root.dispArt
                    px: 128
                    radius: Math.max(3, bar.coverSize * 0.14)
                    visible: root.dispArt != "" && !coverImg.failed
                }
                Kirigami.Icon {
                    anchors.fill: parent
                    anchors.margins: 3
                    source: "folder-music-symbolic"
                    color: root.cActive
                    visible: root.dispArt == "" || coverImg.failed
                    opacity: 0.6
                }
            }

            Item {
                Layout.fillWidth: !bar.fixedW
                Layout.preferredWidth: bar.pad
            }

            Item {
                id: viewport
                opacity: root.isActive || root.hasTrack ? 1.0 : 0.65
                Layout.alignment: Qt.AlignVCenter
                Layout.fillWidth: bar.fixedW
                Layout.preferredHeight: bar.thick
                Layout.preferredWidth: bar.fixedW
                                      ? 0
                                      : Math.min(curLine.width + 2, bar.lyricsMaxW, bar.frozenViewportW)
                clip: true

                Item {
                    id: content
                    height: parent.height
                    width: curLine.width

                    LyricLineView {
                        id: prevLine
                        height: content.height
                        opacity: 0
                        textColor: root.cActive
                        fontPx: bar.lyricPx
                        playing: false
                        sweep: false
                    }

                    LyricLineView {
                        id: curLine
                        height: content.height
                        textColor: root.cActive
                        fontPx: bar.lyricPx
                        playing: root.isPlaying
                        sweep: root.wordsAnimEnabled
                    }

                    ParallelAnimation {
                        id: slideAnim
                        NumberAnimation {
                            target: prevLine; property: "y"
                            to: -bar.thick * 0.55
                            duration: 380; easing.type: Easing.OutCubic
                        }
                        NumberAnimation {
                            target: prevLine; property: "opacity"
                            to: 0; duration: 300; easing.type: Easing.OutQuad
                        }
                        NumberAnimation {
                            target: curLine; property: "y"
                            to: 0
                            duration: 380; easing.type: Easing.OutCubic
                        }
                        NumberAnimation {
                            target: curLine; property: "opacity"
                            to: 1; duration: 260; easing.type: Easing.OutQuad
                        }
                    }

                    SequentialAnimation {
                        id: marqueeAnim
                        loops: Animation.Infinite
                        PauseAnimation { duration: 2000 }
                        NumberAnimation {
                            target: content; property: "x"
                            to: Math.min(0, viewport.width - content.width)
                            duration: Math.max(1000, (content.width - viewport.width) * 35)
                        }
                        PauseAnimation { duration: 2000 }
                        NumberAnimation { target: content; property: "x"; to: 0; duration: 600 }
                    }
                    function marqueeCheck() {
                        marqueeAnim.stop();
                        content.x = 0;
                        if (Plasmoid.configuration.marquee && root.winVisible && bar.shown
                                && (root.isPlaying || root.expanded)
                                && content.width > viewport.width + 1)
                            marqueeAnim.start();
                    }
                }
                QtObject {
                    id: marquee
                    function reset() { content.marqueeCheck(); }
                }
                onWidthChanged: content.marqueeCheck()
                Connections {
                    target: root
                    function onWinVisibleChanged() { content.marqueeCheck(); }
                    function onIsPlayingChanged() { content.marqueeCheck(); }
                    function onExpandedChanged() { content.marqueeCheck(); }
                }
            }

            Item {
                Layout.fillWidth: !bar.fixedW
                Layout.preferredWidth: bar.pad
            }

            RowLayout {
                id: buttonsRow
                spacing: 0
                Layout.alignment: Qt.AlignVCenter
                Layout.minimumWidth: implicitWidth

                SkipButton {
                    forward: false
                    size: bar.thick * 0.9
                    glyphColor: root.cActive
                    enabled: root.playerMatches && root.trackTitle !== "" && root.player.canGoPrevious
                    onClicked: root.doPrev()
                }
                PlayButton {
                    playing: root.isPlaying
                    size: bar.thick * 0.9
                    glyphColor: root.cActive
                    enabled: root.playerMatches && root.trackTitle !== ""
                    onClicked: root.doPlayPause()
                }
                SkipButton {
                    forward: true
                    size: bar.thick * 0.9
                    glyphColor: root.cActive
                    enabled: root.playerMatches && root.trackTitle !== "" && root.player.canGoNext
                    onClicked: root.doNext()
                }
            }
        }
    }

    fullRepresentation: Item {
        id: popup
        Layout.preferredWidth: Kirigami.Units.gridUnit * 34
        Layout.preferredHeight: mainCol.implicitHeight + Kirigami.Units.gridUnit * 2
        Layout.minimumWidth: Kirigami.Units.gridUnit * 28
        Layout.minimumHeight: Layout.preferredHeight
        Layout.maximumHeight: Layout.preferredHeight

        // DMS lyrics toggle: the transcript takes the hero's left column and
        // can be hidden, letting the cover deck take over. The choice is kept
        // across sessions.
        readonly property bool showLyrics: Plasmoid.configuration.popupLyrics !== false
        function toggleLyrics() {
            Plasmoid.configuration.popupLyrics = !popup.showLyrics;
        }

        Timer {
            interval: 500
            repeat: true
            running: root.expanded && root.isPlaying
            onTriggered: {
                root.uiPosMs = root.nowMs();
                if (!root.haveSynced) root.safeCall(["updatePosition"]);
            }
        }

        function fmt(ms) {
            var s = Math.max(0, Math.round(ms / 1000));
            var m = Math.floor(s / 60);
            s = s % 60;
            return m + ":" + (s < 10 ? "0" : "") + s;
        }

        ColumnLayout {
            id: mainCol
            anchors.centerIn: parent
            width: parent.width - Kirigami.Units.gridUnit * 2
            spacing: Kirigami.Units.smallSpacing * 2

            // search box
            Loader {
                Layout.fillWidth: true
                active: root.pear !== null
                visible: active
                sourceComponent: SearchBox {
                    api: root.pear
                    placeholder: i18n("Search YouTube Music")
                }
            }
            Loader {
                Layout.fillWidth: true
                active: root.spotifyMode
                visible: active
                sourceComponent: SearchBox {
                    api: root.spotifyApi
                    placeholder: i18n("Search Spotify")
                }
            }

            // DMS media card hero: the transcript lyrics sit on the left and
            // the cover deck on the right; the lyrics button hides the text
            // and gives the deck the full width, like DMS's lyrics toggle.
            Item {
                id: hero
                Layout.fillWidth: true
                Layout.preferredHeight: Kirigami.Units.gridUnit * 15

                readonly property real gap: Kirigami.Units.largeSpacing
                readonly property real deckMax: Kirigami.Units.gridUnit * 16

                Item {
                    id: lyricPane
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    width: Math.round(popup.showLyrics
                                      ? hero.width * 0.52 - hero.gap / 2
                                      : 0)
                    Behavior on width {
                        NumberAnimation { duration: 260; easing.type: Easing.OutCubic }
                    }
                    visible: width > Kirigami.Units.gridUnit * 8

                    Transcript {
                        id: transcriptView
                        anchors.fill: parent
                        function resumeFollow() {
                            following = true;
                            followTimer.restart();
                        }
                    }

                    Rectangle {
                        anchors.top: parent.top
                        anchors.left: parent.left
                        anchors.right: parent.right
                        height: Math.min(transcriptView.height * 0.2, Kirigami.Units.gridUnit * 2)
                        gradient: Gradient {
                            GradientStop { position: 0; color: Kirigami.Theme.backgroundColor }
                            GradientStop { position: 1; color: "transparent" }
                        }
                    }
                    Rectangle {
                        anchors.bottom: parent.bottom
                        anchors.left: parent.left
                        anchors.right: parent.right
                        height: Math.min(transcriptView.height * 0.2, Kirigami.Units.gridUnit * 2)
                        gradient: Gradient {
                            GradientStop { position: 0; color: "transparent" }
                            GradientStop { position: 1; color: Kirigami.Theme.backgroundColor }
                        }
                    }

                    // DMS "Follow playback" pill, shown while the user browses
                    Rectangle {
                        id: followPill
                        anchors.horizontalCenter: parent.horizontalCenter
                        anchors.bottom: parent.bottom
                        anchors.bottomMargin: Kirigami.Units.smallSpacing * 2
                        visible: root.haveSynced && !transcriptView.following
                        radius: height / 2
                        color: Qt.alpha(root.cActive, 0.18)
                        width: followRow.implicitWidth + Kirigami.Units.gridUnit
                        height: Kirigami.Units.gridUnit * 1.6

                        Row {
                            id: followRow
                            anchors.centerIn: parent
                            spacing: Kirigami.Units.smallSpacing
                            Kirigami.Icon {
                                source: "go-jump-locationbar"
                                width: Kirigami.Units.iconSizes.small
                                height: width
                                color: root.cActive
                                anchors.verticalCenter: parent.verticalCenter
                            }
                            Text {
                                textFormat: Text.PlainText
                                text: i18n("Follow playback")
                                color: root.cActive
                                font.family: root.cfgFont
                                font.pixelSize: Kirigami.Theme.smallFont.pixelSize
                                font.weight: Font.DemiBold
                                anchors.verticalCenter: parent.verticalCenter
                            }
                        }
                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: transcriptView.resumeFollow()
                        }
                    }

                    // loading / empty states, like DMS's pending indicator and
                    // none/instrumental messages
                    Column {
                        anchors.centerIn: parent
                        width: Math.min(parent.width - Kirigami.Units.gridUnit, Kirigami.Units.gridUnit * 12)
                        spacing: Kirigami.Units.smallSpacing
                        visible: !root.haveSynced && (root.isActive || root.fetching)

                        PC3.BusyIndicator {
                            visible: root.fetching
                            x: (parent.width - width) / 2
                        }
                        Text {
                            width: parent.width
                            visible: !root.fetching && root.isActive
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                            textFormat: Text.PlainText
                            text: root.songInstrumental ? i18n("Instrumental")
                                                        : i18n("No synced lyrics found")
                            color: root.cActive
                            opacity: 0.5
                            font.family: root.cfgFont
                            font.pixelSize: Kirigami.Theme.smallFont.pixelSize
                        }
                    }
                }

                // hide / show lyrics button, DMS style
                Rectangle {
                    id: lyricToggle
                    anchors.top: parent.top
                    anchors.right: parent.right
                    width: Kirigami.Units.iconSizes.small + Kirigami.Units.smallSpacing * 2
                    height: width
                    radius: Kirigami.Units.smallSpacing
                    color: toggleArea.containsMouse
                           ? Qt.alpha(root.cActive, 0.18)
                           : Qt.alpha(root.cActive, 0.08)

                    Kirigami.Icon {
                        anchors.centerIn: parent
                        source: "view-media-lyrics"
                        width: Kirigami.Units.iconSizes.small
                        height: width
                        color: root.cActive
                        opacity: popup.showLyrics ? 1 : 0.45
                    }
                    MouseArea {
                        id: toggleArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: popup.toggleLyrics()
                    }
                    PC3.ToolTip.visible: toggleArea.containsMouse
                    PC3.ToolTip.delay: 500
                    PC3.ToolTip.text: popup.showLyrics ? i18n("Hide lyrics")
                                                       : i18n("Show lyrics")
                }

                // deck (right): album art with the title block below it,
                // centred in the space the transcript leaves over
                ColumnLayout {
                    id: deck
                    anchors.verticalCenter: parent.verticalCenter
                    x: lyricPane.width + hero.gap
                       + Math.max(0, (hero.width - lyricPane.width - hero.gap - width) / 2)
                    width: Math.max(Kirigami.Units.gridUnit * 8,
                                    Math.min(hero.width - lyricPane.width - hero.gap,
                                             hero.deckMax))
                    spacing: Kirigami.Units.smallSpacing

                    Behavior on x {
                        NumberAnimation { duration: 260; easing.type: Easing.OutCubic }
                    }

                    Item {
                        id: deckCover
                        Layout.alignment: Qt.AlignHCenter
                        Layout.preferredWidth: Math.min(deck.width, hero.height * 0.62)
                        Layout.preferredHeight: width

                        CoverImage {
                            id: bigCover
                            anchors.fill: parent
                            src: root.dispArt
                            px: 512
                            radius: 14
                            visible: root.dispArt != "" && !bigCover.failed
                        }
                        Kirigami.Icon {
                            anchors.fill: parent
                            anchors.margins: Kirigami.Units.gridUnit
                            source: "media-album-cover"
                            color: root.cActive
                            visible: root.dispArt == "" || bigCover.failed
                            opacity: 0.5
                        }
                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.doRaise()
                            onWheel: function (wheel) {
                                if (!root.canSetVolume) return;
                                root.changeVol(wheel.angleDelta.y > 0 ? 5 : -5);
                                if (root.canSetVolume) volOverlay.show();
                                wheel.accepted = true;
                            }
                        }
                        Rectangle {
                            id: volOverlay
                            anchors.fill: parent
                            radius: 14
                            color: Qt.rgba(0.15, 0.15, 0.15, 0.72)
                            opacity: 0
                            function show() { opacity = 1; volHide.restart(); }
                            Behavior on opacity { NumberAnimation { duration: 150 } }
                            Text {
                                textFormat: Text.PlainText
                                id: volLabel
                                anchors.centerIn: parent
                                text: root.playerMatches && root.player.volume !== undefined
                                      ? Math.round(root.player.volume * 100) + "%" : ""
                                color: root.cActive
                                font.family: root.cfgFont
                                font.pixelSize: Kirigami.Units.gridUnit * 2.4
                                font.weight: Font.DemiBold
                            }
                            Timer {
                                id: volHide
                                interval: 900
                                onTriggered: volOverlay.opacity = 0
                            }
                        }
                    }

                    MarqueeText {
                        Layout.alignment: Qt.AlignHCenter
                        Layout.preferredWidth: deck.width
                        text: root.dispTitle !== "" ? Lrc.normalize(root.dispTitle)
                                                    : i18n("Nothing playing")
                        font.family: root.cfgFont
                        fontCss: root.cfgFontCss
                        font.pixelSize: Kirigami.Theme.defaultFont.pixelSize * 1.5
                        font.bold: true
                        color: root.cActive
                        scrolling: Plasmoid.configuration.marquee && root.expanded && root.winVisible
                    }
                    MarqueeText {
                        Layout.alignment: Qt.AlignHCenter
                        Layout.preferredWidth: deck.width
                        visible: root.isActive || root.optimistic !== null
                        text: {
                            var parts = [];
                            if (root.dispArtist !== "") parts.push(Lrc.normalize(root.dispArtist));
                            if (root.trackAlbum !== "") parts.push(Lrc.normalize(root.trackAlbum));
                            return parts.join(" · ");
                        }
                        color: root.cActive
                        textOpacity: 0.7
                        font.family: root.cfgFont
                        fontCss: root.cfgFontCss
                        scrolling: Plasmoid.configuration.marquee && root.expanded && root.winVisible
                    }
                }
            }

            // song progress bar
            RowLayout {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                TextMetrics {
                    id: timeMetrics
                    font.family: root.cfgFont
                    font.pixelSize: Kirigami.Theme.smallFont.pixelSize
                    text: popup.fmt(Math.max(root.lengthMs, root.uiPosMs)).replace(/[0-9]/g, "0")
                }

                PC3.Label {
                    textFormat: Text.PlainText
                    text: popup.fmt(root.isActive ? (seekBar.dragging ? seekBar.dragTargetMs : root.uiPosMs) : 0)
                    color: root.cActive
                    font.family: root.cfgFont
                    font.pixelSize: Kirigami.Theme.smallFont.pixelSize
                    opacity: 0.7
                    horizontalAlignment: Text.AlignLeft
                    Layout.preferredWidth: Math.ceil(timeMetrics.width)
                    Layout.minimumWidth: Layout.preferredWidth
                }
                Item {
                    id: seekBar
                    Layout.fillWidth: true
                    Layout.preferredHeight: Kirigami.Units.gridUnit
                    property bool dragging: false
                    property real dragRatio: 0
                    property real dragLenMs: 0
                    readonly property real dragTargetMs: dragRatio * (dragLenMs > 0 ? dragLenMs : root.lengthMs)
                    readonly property real ratio: !root.isActive || root.lengthMs <= 0 ? 0
                        : Math.max(0, Math.min(1, dragging ? dragRatio : root.uiPosMs / root.lengthMs))

                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width
                        height: 4
                        radius: 2
                        color: Qt.alpha(root.cInactive, 0.45)
                    }
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: seekBar.ratio * parent.width
                        height: 4
                        radius: 2
                        color: root.cActive
                    }
                    Rectangle {
                        visible: root.isActive
                        anchors.verticalCenter: parent.verticalCenter
                        x: seekBar.ratio * (parent.width - width)
                        width: 12
                        height: 12
                        radius: 6
                        color: root.cActive
                    }
                    MouseArea {
                        anchors.fill: parent
                        enabled: root.isActive && root.playerMatches && root.player.canSeek
                                 && root.lengthMs > 0
                        onPressed: function (mouse) {
                            seekBar.dragging = true;
                            seekBar.dragLenMs = root.lengthMs;
                            seekBar.dragRatio = Math.max(0, Math.min(1, mouse.x / width));
                        }
                        onPositionChanged: function (mouse) {
                            if (seekBar.dragging)
                                seekBar.dragRatio = Math.max(0, Math.min(1, mouse.x / width));
                        }
                        onReleased: {
                            var target = seekBar.dragTargetMs;
                            seekBar.dragging = false;
                            if (seekBar.dragLenMs <= 0 && root.lengthMs <= 0) return;
                            root.seekToMs(target);
                            root.uiPosMs = target;
                        }
                    }
                }
                PC3.Label {
                    textFormat: Text.PlainText
                    text: popup.fmt(root.isActive ? root.lengthMs : 0)
                    color: root.cActive
                    font.family: root.cfgFont
                    font.pixelSize: Kirigami.Theme.smallFont.pixelSize
                    opacity: 0.7
                    horizontalAlignment: Text.AlignRight
                    Layout.preferredWidth: Math.ceil(timeMetrics.width)
                    Layout.minimumWidth: Layout.preferredWidth
                }
            }

            // control buttons
            RowLayout {
                Layout.alignment: Qt.AlignHCenter
                spacing: Kirigami.Units.largeSpacing

                GlyphButton {
                    glyph: "shuffle"
                    size: Kirigami.Units.iconSizes.medium
                    glyphColor: root.cActive
                    active: root.shuffleOn
                        || (root.playerMatches && root.player.shuffle === Mpris.ShuffleStatus.On)
                    enabled: root.hasTrack && root.canShuffle
                    onClicked: root.doShuffle()
                }
                SkipButton {
                    forward: false
                    size: Kirigami.Units.iconSizes.medium
                    glyphColor: root.cActive
                    enabled: root.playerMatches && root.trackTitle !== "" && root.player.canGoPrevious
                    onClicked: root.doPrev()
                }
                PlayButton {
                    playing: root.isPlaying
                    size: Kirigami.Units.iconSizes.medium
                    glyphColor: root.cActive
                    enabled: root.playerMatches && root.trackTitle !== ""
                    onClicked: root.doPlayPause()
                }
                SkipButton {
                    forward: true
                    size: Kirigami.Units.iconSizes.medium
                    glyphColor: root.cActive
                    enabled: root.playerMatches && root.trackTitle !== "" && root.player.canGoNext
                    onClicked: root.doNext()
                }
                GlyphButton {
                    readonly property bool loopTrack: root.repeatMode === "ONE"
                        || (root.playerMatches && root.player.loopStatus === Mpris.LoopStatus.Track)
                    readonly property bool loopAny: root.repeatMode !== "NONE"
                        || (root.playerMatches
                            && (root.player.loopStatus === Mpris.LoopStatus.Playlist
                                || root.player.loopStatus === Mpris.LoopStatus.Track))
                    glyph: loopTrack ? "repeatOne" : "repeat"
                    size: Kirigami.Units.iconSizes.medium
                    glyphColor: root.cActive
                    active: loopAny
                    enabled: root.hasTrack && root.canLoop
                    onClicked: root.doLoop()
                }
            }

            // volume slider
            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: Kirigami.Units.gridUnit * 2
                Layout.rightMargin: Kirigami.Units.gridUnit * 2
                visible: Plasmoid.configuration.showVolumeBar && root.canSetVolume
                spacing: Kirigami.Units.smallSpacing

                Kirigami.Icon {
                    readonly property real v: root.playerMatches && root.player.volume !== undefined ? root.player.volume : 0
                    source: v <= 0.001 ? "audio-volume-muted"
                          : v < 0.34 ? "audio-volume-low"
                          : v < 0.67 ? "audio-volume-medium" : "audio-volume-high"
                    color: root.cActive
                    opacity: 0.75
                    Layout.preferredWidth: Kirigami.Units.iconSizes.small
                    Layout.preferredHeight: Kirigami.Units.iconSizes.small
                }
                Item {
                    id: volBar
                    Layout.fillWidth: true
                    Layout.preferredHeight: Kirigami.Units.gridUnit * 0.7
                    readonly property real ratio: root.playerMatches && root.player.volume !== undefined
                        ? Math.max(0, Math.min(1, root.player.volume)) : 0

                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width
                        height: 3
                        radius: 1.5
                        color: Qt.alpha(root.cInactive, 0.4)
                    }
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: volBar.ratio * parent.width
                        height: 3
                        radius: 1.5
                        color: Qt.alpha(root.cActive, 0.85)
                    }
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        x: volBar.ratio * (parent.width - width)
                        width: 8
                        height: 8
                        radius: 4
                        color: root.cActive
                    }
                    MouseArea {
                        anchors.fill: parent
                        onPressed: function (mouse) { root.setVol01(mouse.x / width); }
                        onPositionChanged: function (mouse) { if (pressed) root.setVol01(mouse.x / width); }
                        onWheel: function (wheel) {
                            root.changeVol(wheel.angleDelta.y > 0 ? 5 : -5);
                            wheel.accepted = true;
                        }
                    }
                }
                PC3.Label {
                    textFormat: Text.PlainText
                    text: (root.playerMatches && root.player.volume !== undefined
                           ? Math.round(root.player.volume * 100) : 0) + "%"
                    color: root.cActive
                    font.family: root.cfgFont
                    font.pixelSize: Kirigami.Theme.smallFont.pixelSize
                    opacity: 0.6
                    horizontalAlignment: Text.AlignRight
                    Layout.preferredWidth: Kirigami.Units.gridUnit * 1.6
                }
            }

            // start stop buttons
            Loader {
                Layout.alignment: Qt.AlignHCenter
                active: root.showAppButton
                visible: active
                source: "AppButton.qml"
            }
        }
    }
}

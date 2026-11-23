const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const providerPath = path.join(__dirname, "..", "Chorus", "contents", "code", "providers.js");
const lrcPath = path.join(__dirname, "..", "Chorus", "contents", "code", "lrc.js");
const stripQmlDirectives = source => source.split("\\n")
    .filter(line => !line.startsWith(".pragma") && !line.startsWith(".import"))
    .join("\\n");
const lrcSandbox = vm.createContext({});
new vm.Script(stripQmlDirectives(fs.readFileSync(lrcPath, "utf8")),
    { filename: "lrc.js" }).runInContext(lrcSandbox);
const sandbox = vm.createContext({
    Lrc: { finalizeLines: lrcSandbox.finalizeLines }
});
new vm.Script(stripQmlDirectives(fs.readFileSync(providerPath, "utf8")),
    { filename: "providers.js" }).runInContext(sandbox);

const remixContext = {
    title: "Heads Will Roll - A-Trak Remix",
    artist: "Yeah Yeah Yeahs",
    durS: 383
};

test("normalizes punctuation without discarding remix identity", () => {
    assert.equal(
        sandbox.dmsTitlesEquivalent(remixContext.title, "Heads Will Roll (A-Trak Remix)"),
        true
    );
    assert.equal(
        sandbox.dmsTitlesEquivalent(
            remixContext.title,
            "Heads Will Roll (A-Trak Remix Radio Edit)"
        ),
        false
    );
});

test("selects the A-Trak Remix rather than the original or radio edit", () => {
    const hits = [
        { isrc: "original", title: "Heads Will Roll", artist: "Yeah Yeah Yeahs", duration: 220 },
        { isrc: "radio-edit", title: "Heads Will Roll (A-Trak Remix Radio Edit)",
          artist: "Yeah Yeah Yeahs", duration: 202 },
        { isrc: "a-trak-remix", title: "Heads Will Roll (A-Trak Remix)",
          artist: "Yeah Yeah Yeahs", duration: 383 }
    ];
    const selected = sandbox.lrcRedChooseHit(hits, remixContext);
    assert.equal(selected && selected.isrc, "a-trak-remix");
});

test("rejects the original recording when a remix is requested", () => {
    const song = {
        lines: [{ t: 0, e: 1000, text: "Dance" }],
        matchTitle: "Heads Will Roll",
        matchArtist: "Yeah Yeah Yeahs",
        durMs: 220000
    };
    assert.equal(
        sandbox.dmsMetadataProblem(remixContext, song),
        "track/version mismatch"
    );
});

test("accepts the exact remix title even if the provider duration is rounded", () => {
    const song = {
        lines: [{ t: 0, e: 1000, text: "Dance" }],
        matchTitle: "Heads Will Roll (A-Trak Remix)",
        matchArtist: "Yeah Yeah Yeahs",
        durMs: 379000
    };
    assert.equal(sandbox.dmsMetadataProblem(remixContext, song), "");
});

test("rejects a base-title result when remix duration is not verified", () => {
    const song = {
        lines: [{ t: 0, e: 1000, text: "Dance" }],
        matchTitle: "Heads Will Roll",
        matchArtist: "Yeah Yeah Yeahs",
        durMs: 0
    };
    assert.equal(
        sandbox.dmsMetadataProblem(remixContext, song),
        "track/version mismatch"
    );
});

test("accepts an exact remix title when the player has not reported duration yet", () => {
    const song = {
        lines: [{ t: 0, e: 1000, text: "Dance" }],
        matchTitle: "Heads Will Roll (A-Trak Remix)",
        matchArtist: "Yeah Yeah Yeahs",
        durMs: 383000
    };
    assert.equal(
        sandbox.dmsMetadataProblem({ ...remixContext, durS: 0 }, song),
        ""
    );
});

test("requires positive version evidence when neither source title nor duration identifies the remix", () => {
    const song = {
        lines: [{ t: 0, e: 1000, text: "Dance" }],
        durMs: 0
    };
    assert.equal(
        sandbox.dmsMetadataProblem({ ...remixContext, durS: 0 }, song),
        "version not verified"
    );
});

test("does not reject ordinary tracks when providers omit title or duration", () => {
    const context = { title: "DOPAMINE HIT", artist: "ALRT", durS: 175 };
    const song = {
        lines: [{ t: 0, e: 1000, text: "Dopamine hit" }],
        wordSync: true,
        durMs: 0
    };
    assert.equal(sandbox.dmsMetadataProblem(context, song), "");
});

test("keeps a lyrics result in the provider race when ordinary metadata is missing", () => {
    const context = {
        title: "DOPAMINE HIT",
        artist: "ALRT",
        durS: 175,
        log: () => {}
    };
    const song = {
        lines: [{ t: 0, e: 1000, text: "Dopamine hit" }],
        wordSync: true,
        durMs: 0
    };
    assert.equal(sandbox.dmsPick(context, [song]), song);
});

test("does not reject ordinary tracks for a provider duration discrepancy", () => {
    const context = { title: "DOPAMINE HIT", artist: "ALRT", durS: 175 };
    const song = {
        lines: [{ t: 0, e: 1000, text: "Dopamine hit" }],
        matchTitle: "DOPAMINE HIT",
        matchArtist: "ALRT",
        durMs: 170000
    };
    assert.equal(sandbox.dmsMetadataProblem(context, song), "");
});

test("reads provider track metadata without substituting the player's duration", () => {
    assert.deepEqual(
        JSON.parse(JSON.stringify(sandbox.providerTrackInfo({
            track: "Heads Will Roll (A-Trak Remix)",
            artist: "Yeah Yeah Yeahs",
            duration: 383
        }))),
        {
            title: "Heads Will Roll (A-Trak Remix)",
            artist: "Yeah Yeah Yeahs",
            duration: 383
        }
    );
    assert.equal(
        sandbox.providerTrackInfo({ track: { title: "Remix", length: 383000 } }).duration,
        383
    );
});

test("SyncLRC TTML removes background, translation and romanization tracks", () => {
    const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
        xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
      <body><div><p begin="00:00:01.000" end="00:00:03.000">
        <span begin="00:00:01.000" end="00:00:01.200">I</span>
        <span begin="00:00:01.200" end="00:00:01.500">don't</span>
        <span begin="00:00:01.500" end="00:00:01.800">want</span>
        <span begin="00:00:01.800" end="00:00:02.000">this</span>
        <span ttm:role="x-bg"><span begin="00:00:02.100">中文背景歌词</span></span>
        <span ttm:role="x-translation"><span begin="00:00:02.200">中文翻译</span></span>
        <span ttm:role="x-roman"><span begin="00:00:02.300">zhong wen fan yi</span></span>
      </p></div></body>
    </tt>`;
    const song = sandbox.ttmlToSong(ttml);
    assert.ok(song);
    assert.equal(song.lines.length, 1);
    assert.equal(song.lines[0].text, "I don't want this");
    assert.equal(song.wordSync, true);
    assert.equal(song.lines[0].words.map(word => word.text).join(""), "I don't want this");
});

test("SyncLRC adjacent timed English words get spaces without splitting contractions", () => {
    const ttml = `<tt xmlns="http://www.w3.org/ns/ttml">
      <body><div><p begin="00:00:01.000" end="00:00:04.000">
        <span begin="00:00:01.000">Don't</span><span begin="00:00:01.300">stop</span><span begin="00:00:01.600">me</span><span begin="00:00:01.800">now!</span>
      </p></div></body>
    </tt>`;
    const song = sandbox.ttmlToSong(ttml);
    assert.ok(song);
    assert.equal(song.lines[0].text, "Don't stop me now!");
    assert.equal(song.wordSync, true);
});

test("SyncLRC provider requests structured TTML rather than flattened LRC", () => {
    const providerSource = fs.readFileSync(providerPath, "utf8");
    const start = providerSource.indexOf("function fetchSyncLRC");
    const end = providerSource.indexOf("// SyncLyrics API exposes", start);
    assert.ok(start >= 0 && end > start);
    const adapter = providerSource.slice(start, end);
    assert.match(adapter, /type=karaoke&format=ttml/);
    assert.match(adapter, /ttmlToSong\\(unwrapTtml\\(ttml\\)\\)/);
});

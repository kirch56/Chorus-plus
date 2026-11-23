const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const providerPath = path.join(__dirname, "..", "Chorus", "contents", "code", "providers.js");
const source = fs.readFileSync(providerPath, "utf8")
    .replace(/^\\.(?:pragma|import)\\b.*$/gm, "");
const sandbox = vm.createContext({});
new vm.Script(source, { filename: "providers.js" }).runInContext(sandbox);

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

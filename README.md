<div align="center">

# Chorus

**Chorus is a KDE Plasma 6 music bar with synced lyrics for any media player, in-widget song search and playback through YouTube Music or Spotify, and media controls.**
     
<img src="media/readme/img.png" width="600">

</div>

> [!IMPORTANT]  
> This widget does require some setup for music search. See [SETUP.md](SETUP.md).

## Showcase

**Search and play**: search YouTube Music or Spotify from the widget and play a song directly.



https://github.com/user-attachments/assets/faf50530-13bc-4692-bbcb-5fe21c2a55e9



**Synced lyrics in your panel**: the current line updates as the song plays.



https://github.com/user-attachments/assets/e3b32a9c-cc4a-4757-b992-5d050d43fa32



**Customisable**: colors, font and size are configurable, and it works in any language.



https://github.com/user-attachments/assets/aff481a7-01e9-43f6-9053-7931b17a784e



**The popup**: album cover, song info, curren lyric, and controls for the song.

<img src="media/readme/img2.png" width="600">

**Songs with no lyrics**: the widget shows title and artist instead.

<img src="media/readme/img3.png" width="600">

## Features

- **Synced lyrics** raced across **six providers** — Better Lyrics, Unison, LyricsPlus, KuGou, LRCLIB and YouTube Music — with a DMS-style scoring: the best answer wins, not just the first one.
- **Word-by-word sync**: when a source carries word timings (LRCLIB lyricsfiles, Better Lyrics / Unison TTML, LyricsPlus Musixmatch word sync), words light up one by one as they are sung — an Apple Music style karaoke sweep in the panel and the popup. Toggle it under **Look & Feel → Animation**.
- **DMS-style popup** (ported from [Dux Modular Shell](https://github.com/AvengeMedia/DankMaterialShell)): scrolling lyrics transcript on the left — the sung line centred, big and sweeping word by word, click any line to seek, "Follow playback" after scrolling around — and the album cover with the track on the right. A lyrics button hides the text and hands the space to the cover.
- Works with **any media player**: Spotify, YouTube Music, VLC, etc.
- Album cover, current lyric, playback controls, seek bar, shuffle/repeat, volume slider.
- **Fixed panel width** (default) keeps the bar compact — set the exact pixel width, or uncheck it to fit the current lyric line (min/max width in % of screen).
- Custom font with **multiple font** support, colors, width, font scale and other **customisation** features.
- **In-widget music search** via YouTube Music or Spotify. See [SETUP.md](SETUP.md).
- Horizontal **and** vertical panels; content rotates to read along the panel.

## Manual Install

Download from the [GitHub releases](https://github.com/kirch56/Chorus-plus/releases) of this fork (or the [KDE Store](https://store.kde.org/p/2370699) for the original Chorus).

To install:

```sh
kpackagetool6 -t Plasma/Applet -i chorus-plus.plasmoid
```

To update:

```sh
kpackagetool6 -t Plasma/Applet -u chorus-plus.plasmoid
```

> [!NOTE]  
> Run the commands in the same directory as the downloaded file.

## Lyrics

All six providers below are asked at once, like DMS (Dux Modular Shell) does it: every source is raced in parallel and the best answer wins — lyrics whose length matches the track beat ones timed for another cut, word timings beat bare lines, and sources whose timing agrees with the others beat lone outliers. Only among answers that agree does the priority order decide. Each provider can be toggled in the widget settings under **Look & Feel → Lyrics providers**:

1. **Better Lyrics** — the [Better Lyrics API](https://api.betterlyrics.org), Apple Music TTML with per-word timings when available
2. **Unison** — community-submitted synced lyrics at [unison.betterlyrics.org](https://unison.betterlyrics.org); the submitter is credited in the widget log
3. **LyricsPlus** — the [LyricsPlus](https://github.com/ibratabian17/lyricsplus) aggregator (Apple Music, QQ, Musixmatch and more, including word/syllable sync)
4. **KuGou** — the [KuGou](https://www.kugou.com) lyrics library, great for CJK songs (line-level only)
5. **LRCLIB** — the [LRCLIB](https://lrclib.net) library, including its [Lyricsfile](https://lrclib.net/lyricsfile) records with word-level timings
6. **YouTube Music** — timed captions from YouTube's InnerTube API; YouTube blocks some networks entirely, so this one may be unavailable depending on where you are (line-level only)

Gaps longer than 5 seconds render as instrumental breaks, and the footer of the transcript credits the provider the lyrics came from.

The **Word-by-word karaoke sweep** animation (Apple Music style, borrowed from DMS 2.0's Dux Lyrical Engine) fills each word with the highlight color as it is sung, with a soft smoothing window so short syllables glide instead of flicking. Songs without word timings keep the classic line-by-line behavior.

> [!NOTE]  
> If lines feel early or late (e.g. Bluetooth or other latency), adjust **Lyrics timing offset** at the bottom of `Look & Feel`. Positive values show lines earlier; +500 works great for me. Sync quality can also vary from song to song; the timings are community-made, so an occasional desynced song is due to the source data, not your setup. Some songs simply have no synced lyrics on any of the sources; the widget falls back to title/artist.

## Donations

For now, while I set up GitHub Sponsors, I only accept crypto donations:

Bitcoin
```
bc1qyv8d8mghjf9sl34we42u670fp9wska009fa5gj
```

EVM (Ethereum, BNB Smart Chain, etc)
```
0xe6E486b5d5DE64C439d868Cd16492b379bF0FAcb
```

Solana 
```
AFSiUhxK2RLBek6c6tppxHKC9qbsWLtYyW878wHGEGZP
```

## Privacy

Chorus does not collect, store, or sell any user data.

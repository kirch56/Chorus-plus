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

- **Synced lyrics** from [LRCLIB](https://lrclib.net), a free and open-source lyrics library, with **five fallback providers**: Better Lyrics, Unison, LyricsPlus, KuGou and YouTube Music.
- **Word-by-word sync**: when a source carries word timings (LRCLIB lyricsfiles, Better Lyrics / Unison TTML, LyricsPlus Musixmatch word sync), words light up one by one as they are sung — an Apple Music style karaoke sweep in the panel and the popup. Providers with word timings are tried first, and it can be turned off under **Look & Feel → Word sync / Animation**.
- Works with **any media player**: Spotify, YouTube Music, VLC, etc.
- Album cover, current lyric, playback controls, seek bar, shuffle/repeat, volume slider.
- Custom font with **multiple font** support, colors, width, font scale and other **customisation** features.
- **In-widget music search** via YouTube Music or Spotify. See [SETUP.md](SETUP.md).
- Horizontal **and** vertical panels; content rotates to read along the panel.

## Manual Install

Download from the [KDE Store](https://store.kde.org/p/2370699) or [GitHub releases](https://github.com/Netherizzium/chorus/releases).

To install:

```sh
kpackagetool6 -t Plasma/Applet -i chorus.plasmoid
```

To update:

```sh
kpackagetool6 -t Plasma/Applet -u chorus.plasmoid
```

> [!NOTE]  
> Run the commands in the same directory as the downloaded file.

## Lyrics

Synced lyrics come from [LRCLIB](https://lrclib.net), a free and open-source lyrics library — including its [Lyricsfile](https://lrclib.net/lyricsfile) records, which can carry word-level timings. If LRCLIB has no synced lyrics for a song, the widget tries the extra providers below, in this order — each one can be toggled in the widget settings under **Look & Feel → Lyrics providers**:

1. **Better Lyrics** — the [Better Lyrics API](https://api.betterlyrics.org), Apple Music TTML with per-word timings when available
2. **Unison** — community-submitted synced lyrics at [unison.betterlyrics.org](https://unison.betterlyrics.org); the submitter is credited in the widget log
3. **LyricsPlus** — the [LyricsPlus](https://github.com/ibratabian17/lyricsplus) aggregator (Apple Music, QQ, Musixmatch and more, including word/syllable sync)
4. **KuGou** — the [KuGou](https://www.kugou.com) lyrics library, great for CJK songs (line-level only)
5. **YouTube Music** — timed captions from YouTube's InnerTube API; YouTube blocks some networks entirely, so this one may be unavailable depending on where you are (line-level only)

With **Word-sync providers first** enabled (default), sources that can deliver word timings are tried before line-level ones: if LRCLIB only has line-level lyrics for a song, Better Lyrics, Unison and LyricsPlus still get a chance to provide word timings before the line-level result is used. With the option off, the list above is followed in exactly the given order.

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

<p align="center">
  <img src="www/img/music.png" alt="EMP" width="72" height="72">
</p>

# EMP

[![Windows](https://img.shields.io/badge/Windows-10%2B-0078D6?logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![.NET](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&logoColor=white)](https://dotnet.microsoft.com/download)
[![C#](https://img.shields.io/badge/C%23-239120?logo=csharp&logoColor=white)](https://github.com/lazytitanz/EMP)
[![Local only](https://img.shields.io/badge/playback-local%20only-1DB954)](#why-emp)
[![No AI](https://img.shields.io/badge/AI-none-111111)](#why-emp)
[![GitHub last commit](https://img.shields.io/github/last-commit/lazytitanz/EMP)](https://github.com/lazytitanz/EMP/commits/main)

EMP is a local music player for Windows. It was built to feel familiar if you already know Spotify, without streaming, accounts, social features, or AI.

Playback stays on your machine. EMP scans the folders you choose, plays the files that are already there, and keeps the rest of the app small on purpose.

## Why EMP

Streaming apps are useful, but they also come with a lot of extra surface: recommendations, cloud libraries, accounts, and now AI. EMP is the opposite of that.

- **Familiar layout** — sidebar, library, search, and a bottom player bar
- **Local only** — your files, your folders, no streaming catalog
- **No AI** — no recommendations, generated playlists, or assistant features
- **Simple by design** — play music, keep a library, and get out of the way

## Features

- Home, library, search, and settings
- Albums, singles, artists, tracks, playlists, and Liked Songs
- Home greeting with quick picks and recently played
- Collapsible sidebar with library search and recents sorting
- Grid or list library views, with colors pulled from album art
- Shuffle, repeat, seek, volume, and system media controls
- Crossfade, gapless playback, volume normalize, and an equalizer with presets
- Create, edit, and delete playlists
- Artist pages with optional MusicBrainz genre and origin info
- Watches your music folders and refreshes when files change
- Tray icon, optional start with Windows, and taskbar playback buttons
- Session restore so the last queue and position come back after a restart

Supported audio types include MP3, M4A, AAC, FLAC, WAV, OGG, Opus, WMA, AIFF, and ALAC.

## Cast to a device

EMP can play on this computer or send audio to a speaker or TV on your local network.

- **Google Cast** — Chromecast and Cast-enabled speakers
- **DLNA** — UPnP media renderers on the same LAN

Open **Connect to a device** in the player bar, then pick a device. Files are served from your PC; there is no cloud streaming and no transcoding. If a device cannot play a format, switch back to this computer or use a file type that device supports.

Crossfade, gapless playback, and the equalizer apply to local playback.

## Requirements

- Windows 10 version 2004 or later
- [.NET 10](https://dotnet.microsoft.com/download)
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

## Build and run

```bash
dotnet restore
dotnet run
```

On first launch, EMP looks in your Windows Music folder. You can add more folders in Settings.

## Settings

Settings stay local on your PC. You can:

- Choose which folders EMP scans, and rescan the library
- Open EMP when you sign in to Windows (normal or minimized)
- Minimize to the tray instead of quitting
- Turn on crossfade, gapless playback, volume normalize, and the equalizer

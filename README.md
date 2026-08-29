# EMP

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
- Albums, tracks, playlists, and Liked Songs
- Shuffle, repeat, seek, volume, and system media controls
- Crossfade, gapless playback, volume normalize, and an optional equalizer
- Watches your music folders and refreshes when files change
- Tray icon, optional start with Windows, and taskbar playback buttons

Supported audio types include MP3, M4A, AAC, FLAC, WAV, OGG, Opus, WMA, AIFF, and ALAC.

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

- Choose which folders EMP scans
- Open EMP when you sign in to Windows (normal or minimized)
- Minimize to the tray instead of quitting
- Turn on crossfade, gapless playback, volume normalize, and the equalizer

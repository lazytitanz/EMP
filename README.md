<p align="center">
  <img src="www/img/emp-icon-512.png" alt="EMP" width="72" height="72">
</p>

<p align="center">
  <img src="www/img/EMP%20Music%20Player%20Showcase.png" alt="EMP — a cleaner way to listen">
</p>

<h1 align="center">EMP</h1>

<p align="center">
  A modern Windows music player built around the music you already own.
</p>

<p align="center">
  <a href="https://github.com/lazytitanz/EMP/releases/latest">
    <img src="https://img.shields.io/github/v/release/lazytitanz/EMP?label=release" alt="Latest release">
  </a>
  <img src="https://img.shields.io/badge/Windows-10%2B-0078D6?logo=windows&logoColor=white" alt="Windows 10+">
  <img src="https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&logoColor=white" alt=".NET 10">
  <img src="https://img.shields.io/badge/C%23-239120?logo=csharp&logoColor=white" alt="C#">
  <a href="https://github.com/lazytitanz/EMP/commits/main">
    <img src="https://img.shields.io/github/last-commit/lazytitanz/EMP" alt="Last commit">
  </a>
</p>

EMP combines a familiar, streaming-style interface with local playback, library management, playlists, lyrics, audio controls, and network playback — without requiring a streaming service or account.

## Download

**[Download the latest release →](https://github.com/lazytitanz/EMP/releases/latest)**

Download the Windows release, extract the archive, and run **EMP.exe**. No installer is required.

> [!NOTE]
> EMP is currently in early development. You may encounter bugs or unfinished features.

## Features

### Your music library

Add one or more music folders and EMP will organize your collection automatically. Changes to your music folders are detected as they happen, keeping your library up to date.

- Albums, artists, singles, tracks, playlists, and Liked Songs
- Dedicated Playlists library view with grid and list layouts
- Library search with grid and list views
- Recently played music and quick picks
- Create, edit, and delete playlists
- Automatic library updates when files change
- Optional artist information from MusicBrainz
- Artwork-driven colors throughout the interface

### Search

Find anything in your library from a polished Search experience — not just a simple filter.

- Landing page with recent searches and Browse your library shortcuts
- Results for artists, playlists, albums & singles, and songs
- Prominent Top result with the right play or open action
- Relevance ranking across your local collection
- Show more controls for large result sets

### Lyrics

Follow along with the current track in a full lyrics panel.

- Synced lyrics with active-line highlighting when timing is available
- Plain lyrics fallback when synced lines are not available
- Cover-tinted lyrics stage that matches the playing track
- Local caching so lyrics load quickly on repeat listens

### Playback

Everything you'd expect from a modern desktop player, with your music playing directly from your PC.

- Shuffle and repeat
- Seek and volume controls
- Queue drawer for now playing and upcoming tracks
- Crossfade and gapless playback
- Volume normalization
- Equalizer with presets
- Windows system media controls
- Taskbar playback controls
- Session restore for your queue, track, and playback position

Supported formats include **MP3, M4A, AAC, FLAC, WAV, OGG, Opus, WMA, AIFF, and ALAC**.

### Connect to a device

Send your music to compatible speakers, TVs, and other devices on your local network.

- **Google Cast** — Chromecast and Cast-enabled speakers and displays
- **DLNA / UPnP** — compatible TVs, speakers, and media renderers

Open **Connect to a device** from the player bar and choose where you want to listen.

When casting, EMP serves the original audio file directly from your PC over your local network. Your music is not uploaded to a cloud service or transcoded.

> [!NOTE]
> Audio processing such as the equalizer, crossfade, and gapless playback applies to playback on this computer and is not applied when sending the original file to another device.

## Why EMP?

EMP is for people who keep their own music collection but still want the experience of a modern desktop music app.

There's no streaming catalog to subscribe to and no account required to listen. Choose your music folders and EMP builds the experience around your collection.

**The goal is simple: make a local music library feel as polished and convenient as a modern streaming app.**

## Requirements

### Downloaded release

- Windows 10 version 2004 or later
- Microsoft Edge WebView2 Runtime

WebView2 is included with most modern Windows installations.

### Building from source

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- Microsoft Edge WebView2 Runtime

Clone the repository, then run:

```bash
dotnet restore
dotnet run --project EMP
```

### Packaging a release

From the repository root:

```powershell
.\scripts\release.ps1 -Version 0.2.1
```

This publishes self-contained Windows x64 builds of EMP and EMP.Updater, assembles a flat ZIP, and writes a SHA-256 checksum file. Use `scripts/test-update.ps1` for an isolated update dry-run.

EMP can check GitHub Releases from **Settings → Updates**. Updates never install without your consent.

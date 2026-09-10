<p align="center">
  <img src="www/img/music.png" alt="EMP" width="72" height="72">
</p>

<p align="center">
  <img src="www/img/promo.png" alt="EMP — a cleaner way to listen">
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

EMP combines a familiar, streaming-style interface with local playback, library management, playlists, audio controls, and network playback — without requiring a streaming service or account.

## Download

**[Download the latest release →](https://github.com/lazytitanz/EMP/releases/latest)**

Download the Windows release, extract the archive, and run **EMP.exe**. No installer is required.

> [!NOTE]
> EMP is currently in early development. You may encounter bugs or unfinished features.

## Features

### Your music library

Add one or more music folders and EMP will organize your collection automatically. Changes to your music folders are detected as they happen, keeping your library up to date.

- Albums, artists, singles, tracks, playlists, and Liked Songs
- Library search with grid and list views
- Recently played music and quick picks
- Create, edit, and delete playlists
- Automatic library updates when files change
- Optional artist information from MusicBrainz
- Artwork-driven colors throughout the interface

### Playback

Everything you'd expect from a modern desktop player, with your music playing directly from your PC.

- Shuffle and repeat
- Seek and volume controls
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
dotnet run
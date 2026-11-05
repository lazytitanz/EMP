using EMP.Library;
using Sonora.Audio;
using Sonora.Audio.Devices;
using Sonora.Audio.DSP;
using Sonora.Audio.Output;
using Sonora.Audio.Playback;
using Sonora.Audio.Windows;

namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// EMP-owned consumer of Sonora for local PCM. Sonora is authoritative for transport state,
    /// position, duration, and completion. Queue selection stays in EMP.
    /// </summary>
    internal sealed class SonoraPlaybackService : IAsyncDisposable
    {
        private readonly object gate = new();
        private readonly PlaybackCommandGate commands = new();
        private readonly SynchronizationContext? syncContext;

        private AudioEngine? engine;
        private AudioPlayer? player;
        private IPreampEffect? preamp;
        private IEqualizerEffect? equalizer;
        private ILimiterEffect? limiter;

        // Exposed for Phase 3 DSP mapping without digging through Effects.
        internal IPreampEffect? Preamp => preamp;
        internal IEqualizerEffect? Equalizer => equalizer;
        internal ILimiterEffect? Limiter => limiter;

        private string? currentTrackId;
        private string? nextTrackId;
        private string? currentPath;
        private string? nextPath;

        /// <summary>
        /// Last EMP-requested linear gain (0–1 after UI power curve). Sonora defaults to 1;
        /// we re-apply after load/device changes so startup slider restore is audible.
        /// </summary>
        private float outputVolumeLinear = 1f;

        private int disposed;
        private CancellationTokenSource? positionCts;
        private Task? positionLoop;

        public SonoraPlaybackService(SynchronizationContext? synchronizationContext = null)
        {
            syncContext = synchronizationContext;
        }

        public PlaybackCommandGate Commands => commands;

        public bool IsInitialized
        {
            get
            {
                lock (gate)
                {
                    return player is not null;
                }
            }
        }

        /// <summary>True when Sonora currently has a decoded primary source ready for Play/Seek.</summary>
        public bool HasSource
        {
            get
            {
                lock (gate)
                {
                    return player?.HasSource == true;
                }
            }
        }

        public string? CurrentTrackId
        {
            get
            {
                lock (gate)
                {
                    return currentTrackId;
                }
            }
        }

        public string? NextTrackId
        {
            get
            {
                lock (gate)
                {
                    return nextTrackId;
                }
            }
        }

        public event Action<SonoraPlaybackSnapshot>? SnapshotChanged;

        public event Action<SonoraTrackTransitionInfo>? TrackTransitioned;

        public event Action<long, Exception>? ErrorOccurred;

        public event Action<long>? PlaybackCompleted;

        public event Action<OutputDeviceChangedEventArgs>? OutputDeviceChanged;

        public event Action? OutputDevicesChanged;

        public event Action? OutputConfigurationChanged;

        /// <summary>Creates the Shared-mode Sonora engine/player and default DSP rack.</summary>
        public void Initialize()
        {
            ThrowIfDisposed();

            lock (gate)
            {
                if (player is not null)
                {
                    return;
                }

                engine = SonoraWindows.CreateEngine();
                player = engine.CreatePlayer();
                // Shared WASAPI is Sonora's default; exclusive mode stays deferred for this migration.

                preamp = player.Effects.AddPreamp(0f);
                equalizer = player.Effects.AddEqualizer();
                limiter = player.Effects.AddLimiter();
                // Limiter on by default to mirror EMP preventClipping default; Phase 3 maps settings.
                limiter.Enabled = true;
                // Sonora defaults AudioPlayer.Volume to 1; EMP may already have remembered gain.
                player.Volume = outputVolumeLinear;

                player.StateChanged += OnPlayerStateChanged;
                player.PlaybackCompleted += OnPlayerPlaybackCompleted;
                player.TrackTransitioned += OnPlayerTrackTransitioned;
                player.ErrorOccurred += OnPlayerErrorOccurred;
                player.OutputDeviceChanged += OnPlayerOutputDeviceChanged;
                player.OutputConfigurationChanged += OnPlayerOutputConfigurationChanged;
                engine.OutputDevices.DevicesChanged += OnDevicesChanged;
                engine.OutputDevices.DefaultDeviceChanged += OnDefaultDeviceChanged;
            }

            StartPositionLoop();
            PublishSnapshot(commands.Current);
        }

        public string? PreferredOutputDeviceId
        {
            get
            {
                lock (gate)
                {
                    return player?.PreferredOutputDeviceId;
                }
            }
        }

        public string? ActiveOutputDeviceId
        {
            get
            {
                lock (gate)
                {
                    return player?.ActiveOutputDeviceId;
                }
            }
        }

        public SonoraPlaybackSnapshot CaptureSnapshot(long generation)
        {
            ThrowIfDisposed();
            AudioPlayer active = RequirePlayer();

            lock (gate)
            {
                return new SonoraPlaybackSnapshot
                {
                    Generation = generation,
                    State = active.State,
                    TrackId = currentTrackId,
                    NextTrackId = nextTrackId,
                    SourcePath = active.SourcePath,
                    Position = active.Position,
                    BufferedPosition = active.BufferedPosition,
                    Duration = active.Duration,
                    HasKnownDuration = active.HasKnownDuration,
                    Volume = active.Volume,
                    CrossfadeDuration = active.CrossfadeDuration
                };
            }
        }

        public async Task LoadTrackAsync(string trackId, CancellationToken cancellationToken = default)
        {
            ThrowIfDisposed();
            ArgumentException.ThrowIfNullOrWhiteSpace(trackId);

            long generation = commands.BeginCommand();
            try
            {
                string path = ResolvePath(trackId);

                AudioPlayer active = RequirePlayer();
                await active.LoadAsync(path, cancellationToken).ConfigureAwait(false);
                if (!commands.IsCurrent(generation))
                {
                    return;
                }

                // AudioPlayer.LoadAsync can return without throwing when superseded internally
                // (decoder disposed, _hasSource left false). Do not treat that as a loaded track.
                if (!active.HasSource)
                {
                    return;
                }

                lock (gate)
                {
                    currentTrackId = trackId;
                    currentPath = path;
                    nextTrackId = null;
                    nextPath = null;
                }

                // Ensure audible gain matches EMP before any subsequent Play on this load.
                active.Volume = OutputVolumeLinear;
                PublishSnapshot(generation);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (SonoraCommandException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new SonoraCommandException(generation, SonoraPlaybackError.OperationLoad, trackId, ex);
            }
        }

        public async Task PreloadNextAsync(string trackId, CancellationToken cancellationToken = default)
        {
            ThrowIfDisposed();
            ArgumentException.ThrowIfNullOrWhiteSpace(trackId);

            long generation = commands.BeginCommand();
            try
            {
                string path = ResolvePath(trackId);

                AudioPlayer active = RequirePlayer();
                await active.PreloadNextAsync(path, cancellationToken).ConfigureAwait(false);
                if (!commands.IsCurrent(generation))
                {
                    return;
                }

                lock (gate)
                {
                    nextTrackId = trackId;
                    nextPath = path;
                }

                PublishSnapshot(generation);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (SonoraCommandException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new SonoraCommandException(generation, SonoraPlaybackError.OperationPreload, trackId, ex);
            }
        }

        public void ClearNext()
        {
            ThrowIfDisposed();
            long generation = commands.BeginCommand();
            RequirePlayer().ClearNext();

            lock (gate)
            {
                nextTrackId = null;
                nextPath = null;
            }

            PublishSnapshot(generation);
        }

        public void Play()
        {
            ThrowIfDisposed();
            long generation = commands.BeginCommand();
            try
            {
                RequirePlayer().Play();
                PublishSnapshot(generation);
            }
            catch (SonoraCommandException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new SonoraCommandException(generation, SonoraPlaybackError.OperationPlay, currentTrackId, ex);
            }
        }

        public void Pause()
        {
            ThrowIfDisposed();
            long generation = commands.BeginCommand();
            RequirePlayer().Pause();
            PublishSnapshot(generation);
        }

        public void Stop()
        {
            ThrowIfDisposed();
            long generation = commands.BeginCommand();
            RequirePlayer().Stop();

            lock (gate)
            {
                nextTrackId = null;
                nextPath = null;
            }

            PublishSnapshot(generation);
        }

        public void Seek(TimeSpan position)
        {
            ThrowIfDisposed();
            long generation = commands.BeginCommand();
            try
            {
                RequirePlayer().Seek(position);
                PublishSnapshot(generation);
            }
            catch (SonoraCommandException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new SonoraCommandException(generation, SonoraPlaybackError.OperationSeek, currentTrackId, ex);
            }
        }

        /// <summary>Last EMP-requested linear output gain (0–1).</summary>
        public float OutputVolumeLinear
        {
            get
            {
                lock (gate)
                {
                    return outputVolumeLinear;
                }
            }
        }

        public void SetVolume(float linear01)
        {
            ThrowIfDisposed();
            if (linear01 is < 0f or > 1f)
            {
                throw new ArgumentOutOfRangeException(nameof(linear01));
            }

            lock (gate)
            {
                outputVolumeLinear = linear01;
            }

            // Volume is immediate; do not bump generation (avoids dropping in-flight transport events).
            RequirePlayer().Volume = linear01;
            PublishSnapshot(commands.Current);
        }

        /// <summary>
        /// Re-push the last EMP volume onto the live player (e.g. after Load / output rebind).
        /// Safe off the WASAPI callback — only assigns <see cref="AudioPlayer.Volume"/>.
        /// </summary>
        public void ReapplyOutputVolume()
        {
            ThrowIfDisposed();
            float volume;
            AudioPlayer active;
            lock (gate)
            {
                volume = outputVolumeLinear;
                active = player ?? throw new InvalidOperationException("Call Initialize() before using Sonora playback.");
            }

            active.Volume = volume;
        }

        public void SetCrossfadeDuration(TimeSpan duration)
        {
            ThrowIfDisposed();
            RequirePlayer().CrossfadeDuration = duration;
            PublishSnapshot(commands.Current);
        }

        /// <summary>
        /// Applies EMP-computed DSP. ReplayGain is expected as preamp dB for the <em>active</em> track.
        /// Sonora's public rack is post-mix, so overlapping crossfades cannot apply two independent
        /// per-track ReplayGain values — EMP updates preamp on load/transition (incoming becomes active).
        /// </summary>
        public void ApplyDsp(
            float replayGainPreampDb,
            bool equalizerEnabled,
            IReadOnlyList<float> equalizerGainsDb,
            bool limiterEnabled)
        {
            ThrowIfDisposed();
            lock (gate)
            {
                if (preamp is not null)
                {
                    preamp.GainDb = replayGainPreampDb;
                }

                if (equalizer is not null)
                {
                    equalizer.Enabled = equalizerEnabled;
                    int count = Math.Min(equalizer.BandCount, equalizerGainsDb?.Count ?? 0);
                    for (int i = 0; i < count; i++)
                    {
                        equalizer.SetBandGain(i, equalizerGainsDb![i]);
                    }
                }

                if (limiter is not null)
                {
                    limiter.Enabled = limiterEnabled;
                }
            }

            PublishSnapshot(commands.Current);
        }

        public IReadOnlyList<AudioOutputDevice> GetOutputDevices()
        {
            ThrowIfDisposed();
            AudioEngine activeEngine;
            lock (gate)
            {
                activeEngine = engine ?? throw new InvalidOperationException("Sonora is not initialized.");
            }

            return activeEngine.OutputDevices.GetDevices();
        }

        public Task SetOutputDeviceAsync(string? deviceId, CancellationToken cancellationToken = default)
        {
            ThrowIfDisposed();
            long generation = commands.BeginCommand();
            return SetOutputDeviceCoreAsync(generation, deviceId, cancellationToken);
        }

        public AudioOutputConfiguration OutputConfiguration
        {
            get
            {
                ThrowIfDisposed();
                return RequirePlayer().OutputConfiguration;
            }
        }

        public AudioOutputMode? EffectiveOutputMode
        {
            get
            {
                ThrowIfDisposed();
                return RequirePlayer().EffectiveOutputMode;
            }
        }

        public ExclusiveFallbackReason OutputFallbackReason
        {
            get
            {
                ThrowIfDisposed();
                return RequirePlayer().OutputFallbackReason;
            }
        }

        public Task ConfigureOutputAsync(
            AudioOutputConfiguration configuration,
            CancellationToken cancellationToken = default)
        {
            ThrowIfDisposed();
            ArgumentNullException.ThrowIfNull(configuration);
            long generation = commands.BeginCommand();
            return ConfigureOutputCoreAsync(generation, configuration, cancellationToken);
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0)
            {
                return;
            }

            StopPositionLoop();

            AudioEngine? engineLocal;
            AudioPlayer? playerLocal;
            lock (gate)
            {
                engineLocal = engine;
                playerLocal = player;
                engine = null;
                player = null;
                preamp = null;
                equalizer = null;
                limiter = null;
            }

            if (playerLocal is not null)
            {
                playerLocal.StateChanged -= OnPlayerStateChanged;
                playerLocal.PlaybackCompleted -= OnPlayerPlaybackCompleted;
                playerLocal.TrackTransitioned -= OnPlayerTrackTransitioned;
                playerLocal.ErrorOccurred -= OnPlayerErrorOccurred;
                playerLocal.OutputDeviceChanged -= OnPlayerOutputDeviceChanged;
                playerLocal.OutputConfigurationChanged -= OnPlayerOutputConfigurationChanged;
                await playerLocal.DisposeAsync().ConfigureAwait(false);
            }

            if (engineLocal is not null)
            {
                engineLocal.OutputDevices.DevicesChanged -= OnDevicesChanged;
                engineLocal.OutputDevices.DefaultDeviceChanged -= OnDefaultDeviceChanged;
                await engineLocal.DisposeAsync().ConfigureAwait(false);
            }
        }

        private async Task SetOutputDeviceCoreAsync(
            long generation,
            string? deviceId,
            CancellationToken cancellationToken)
        {
            try
            {
                AudioPlayer active = RequirePlayer();
                await active.SetOutputDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
                if (commands.IsCurrent(generation))
                {
                    active.Volume = OutputVolumeLinear;
                    PublishSnapshot(generation);
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (SonoraCommandException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new SonoraCommandException(
                    generation,
                    SonoraPlaybackError.OperationOutputDevice,
                    currentTrackId,
                    ex);
            }
        }

        private async Task ConfigureOutputCoreAsync(
            long generation,
            AudioOutputConfiguration configuration,
            CancellationToken cancellationToken)
        {
            try
            {
                AudioPlayer active = RequirePlayer();
                await active.ConfigureOutputAsync(configuration, cancellationToken).ConfigureAwait(false);
                if (commands.IsCurrent(generation))
                {
                    active.Volume = OutputVolumeLinear;
                    PublishSnapshot(generation);
                    OutputConfigurationChanged?.Invoke();
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (SonoraCommandException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new SonoraCommandException(
                    generation,
                    SonoraPlaybackError.OperationOutputDevice,
                    currentTrackId,
                    ex);
            }
        }

        private void OnPlayerOutputConfigurationChanged(object? sender, OutputConfigurationChangedEventArgs e)
        {
            Post(() =>
            {
                OutputConfigurationChanged?.Invoke();
                PublishSnapshot(commands.Current);
            });
        }

        private void StartPositionLoop()
        {
            StopPositionLoop();
            positionCts = new CancellationTokenSource();
            CancellationToken token = positionCts.Token;
            positionLoop = Task.Run(async () =>
            {
                using PeriodicTimer timer = new(TimeSpan.FromMilliseconds(200));
                try
                {
                    while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false))
                    {
                        long generation = commands.Current;
                        if (!commands.IsCurrent(generation))
                        {
                            continue;
                        }

                        AudioPlayer? active;
                        lock (gate)
                        {
                            active = player;
                        }

                        if (active is null || active.State != global::Sonora.Audio.Formats.PlaybackState.Playing)
                        {
                            continue;
                        }

                        PublishSnapshot(generation);
                    }
                }
                catch (OperationCanceledException)
                {
                    // Expected on dispose.
                }
            }, token);
        }

        private void StopPositionLoop()
        {
            CancellationTokenSource? cts = Interlocked.Exchange(ref positionCts, null);
            if (cts is null)
            {
                return;
            }

            cts.Cancel();
            cts.Dispose();
            positionLoop = null;
        }

        private void OnPlayerStateChanged(object? sender, EventArgs e) =>
            PublishSnapshot(commands.Current);

        private void OnPlayerPlaybackCompleted(object? sender, EventArgs e)
        {
            long generation = commands.Current;
            Post(() =>
            {
                if (!commands.IsCurrent(generation))
                {
                    return;
                }

                PlaybackCompleted?.Invoke(generation);
                PublishSnapshot(generation);
            });
        }

        private void OnPlayerTrackTransitioned(object? sender, TrackTransitionedEventArgs e)
        {
            long generation = commands.Current;
            string? previousId;
            string? nextId;

            lock (gate)
            {
                // Sonora already owns the PCM handoff — EMP only remaps track ids.
                previousId = currentTrackId;
                SonoraQueueHandoff.State after = SonoraQueueHandoff.AfterTransition(
                    new SonoraQueueHandoff.State(currentTrackId, nextTrackId, currentPath, nextPath),
                    e.NextPath);
                currentTrackId = after.CurrentTrackId;
                nextTrackId = after.NextTrackId;
                currentPath = after.CurrentPath;
                nextPath = after.NextPath;
                nextId = currentTrackId;
            }

            Post(() =>
            {
                if (!commands.IsCurrent(generation))
                {
                    return;
                }

                // Gapless/crossfade handoff must keep EMP gain (not Sonora's default unity).
                try
                {
                    ReapplyOutputVolume();
                }
                catch (InvalidOperationException)
                {
                    // Disposed between transition and UI post — ignore.
                }

                TrackTransitioned?.Invoke(new SonoraTrackTransitionInfo
                {
                    Generation = generation,
                    PreviousTrackId = previousId,
                    NextTrackId = nextId,
                    PreviousPath = e.PreviousPath,
                    NextPath = e.NextPath,
                    PreviousDuration = e.PreviousDuration,
                    TransitionId = e.TransitionId
                });
                PublishSnapshot(generation);
            });
        }

        private void OnPlayerErrorOccurred(object? sender, Exception ex)
        {
            long generation = commands.Current;
            Post(() =>
            {
                if (!commands.IsCurrent(generation))
                {
                    return;
                }

                ErrorOccurred?.Invoke(generation, ex);
            });
        }

        private void OnPlayerOutputDeviceChanged(object? sender, OutputDeviceChangedEventArgs e)
        {
            Post(() => OutputDeviceChanged?.Invoke(e));
        }

        private void OnDevicesChanged(object? sender, EventArgs e) =>
            Post(() => OutputDevicesChanged?.Invoke());

        private void OnDefaultDeviceChanged(object? sender, DefaultOutputDeviceChangedEventArgs e) =>
            Post(() => OutputDevicesChanged?.Invoke());

        private void PublishSnapshot(long generation)
        {
            if (!commands.IsCurrent(generation))
            {
                return;
            }

            SonoraPlaybackSnapshot snapshot;
            try
            {
                snapshot = CaptureSnapshot(generation);
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (InvalidOperationException)
            {
                return;
            }

            Post(() =>
            {
                if (!commands.IsCurrent(generation))
                {
                    return;
                }

                SnapshotChanged?.Invoke(snapshot);
            });
        }

        private void Post(Action action)
        {
            if (syncContext is null)
            {
                action();
                return;
            }

            syncContext.Post(_ => action(), null);
        }

        private AudioPlayer RequirePlayer()
        {
            lock (gate)
            {
                return player ?? throw new InvalidOperationException("Call Initialize() before using Sonora playback.");
            }
        }

        private static string ResolvePath(string trackId)
        {
            if (!LibraryMediaIndex.TryGet(trackId, out LibraryMediaLocation location)
                || string.IsNullOrWhiteSpace(location.FullPath))
            {
                throw new FileNotFoundException($"No library media path is registered for track '{trackId}'.", trackId);
            }

            if (!File.Exists(location.FullPath))
            {
                throw new FileNotFoundException($"Media file is missing for track '{trackId}'.", location.FullPath);
            }

            return location.FullPath;
        }

        private void ThrowIfDisposed()
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        }
    }
}

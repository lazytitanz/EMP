using System.Globalization;
using System.Text.Json;
using Sonora.Audio.Devices;
using Sonora.Audio.Output;

namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// WebView2 command/event adapter for <see cref="SonoraPlaybackService"/>.
    /// Keeps generation filtering on the host so stale JS completions cannot drive UI.
    /// </summary>
    internal static class SonoraWebBridge
    {
        private static SonoraPlaybackService? service;
        private static Action<object>? postMessage;
        private static long lastPublishedGeneration;
        /// <summary>
        /// Last EMP-requested linear volume. Accepts posts before Attach/Initialize so
        /// slider restore is not lost when JS races host availability.
        /// </summary>
        private static readonly SonoraOutputVolumeStore OutputVolume = new();
        /// <summary>
        /// Load / preload / output-device changes must not overlap. Concurrent WASAPI device
        /// switches during Media Foundation open have been observed to fail opens that succeed
        /// in Sonora.TestPlayer's sequential path.
        /// </summary>
        private static readonly SemaphoreSlim EngineCommandGate = new(1, 1);

        public static void Attach(SonoraPlaybackService? playback, Action<object>? post)
        {
            if (service is not null)
            {
                service.SnapshotChanged -= OnSnapshot;
                service.TrackTransitioned -= OnTransitioned;
                service.PlaybackCompleted -= OnCompleted;
                service.ErrorOccurred -= OnError;
                service.OutputDeviceChanged -= OnOutputDeviceChanged;
                service.OutputDevicesChanged -= OnOutputDevicesChanged;
                service.OutputConfigurationChanged -= OnOutputConfigurationChanged;
            }

            service = playback;
            postMessage = post;
            lastPublishedGeneration = 0;

            if (service is null)
            {
                PostAvailability(false);
                return;
            }

            service.SnapshotChanged += OnSnapshot;
            service.TrackTransitioned += OnTransitioned;
            service.PlaybackCompleted += OnCompleted;
            service.ErrorOccurred += OnError;
            service.OutputDeviceChanged += OnOutputDeviceChanged;
            service.OutputDevicesChanged += OnOutputDevicesChanged;
            service.OutputConfigurationChanged += OnOutputConfigurationChanged;
            ApplyRememberedVolumeToService();
            PostAvailability(true);
            PostDevices();
        }

        /// <summary>
        /// Re-announce availability to the WebView. Needed because Attach can race the first
        /// navigation — document scripts (EmpSonora) may not exist when the first post fires.
        /// </summary>
        public static void RepublishAvailability() =>
            PostAvailability(service is not null && service.IsInitialized);

        public static void HandleCommand(JsonElement message)
        {
            string? action = message.TryGetProperty("action", out JsonElement actionElement)
                && actionElement.ValueKind == JsonValueKind.String
                    ? actionElement.GetString()
                    : null;

            if (string.Equals(action, "hello", StringComparison.Ordinal))
            {
                RepublishAvailability();
                if (service is not null && service.IsInitialized)
                {
                    ApplyRememberedVolumeToService();
                    PostDevices();
                }

                return;
            }

            // Volume must be accepted before availability — saved UI prefs often post while
            // EmpSonora.available is still false / Attach has not finished.
            if (string.Equals(action, "volume", StringComparison.Ordinal))
            {
                if (TryReadDouble(message, "volume", out double earlyVolume))
                {
                    RememberAndApplyVolume(earlyVolume);
                }

                return;
            }

            if (service is null || !service.IsInitialized)
            {
                PostError(
                    generation: 0,
                    operation: SonoraPlaybackError.OperationUnknown,
                    trackId: null,
                    exception: new InvalidOperationException("Sonora is not available."));
                return;
            }

            if (string.IsNullOrWhiteSpace(action))
            {
                return;
            }

            switch (action)
            {
                case "load":
                    {
                        bool play = message.TryGetProperty("play", out JsonElement playElement)
                            && playElement.ValueKind == JsonValueKind.True;
                        double loadPosition = TryReadDouble(message, "position", out double positionSeconds)
                            ? Math.Max(0, positionSeconds)
                            : 0;
                        double? loadVolume = TryReadDouble(message, "volume", out double volumeOnLoad)
                            ? Math.Clamp(volumeOnLoad, 0, 1)
                            : null;
                        _ = LoadAsync(ReadTrackId(message), play, loadPosition, loadVolume);
                    }
                    break;
                case "preloadNext":
                    _ = PreloadAsync(ReadTrackId(message));
                    break;
                case "clearNext":
                    _ = RunEngineCommandAsync(
                        SonoraPlaybackError.OperationUnknown,
                        trackId: null,
                        static (svc, _) =>
                        {
                            svc.ClearNext();
                            return Task.CompletedTask;
                        });
                    break;
                case "play":
                    _ = RunEngineCommandAsync(
                        SonoraPlaybackError.OperationPlay,
                        trackId: service.CurrentTrackId,
                        static (svc, _) =>
                        {
                            // Avoid the cold-start race where UI Play beats an in-flight LoadAsync.
                            if (!svc.HasSource)
                            {
                                throw new InvalidOperationException(
                                    "No audio source is loaded yet. Wait for load to finish or load the track again.");
                            }

                            // Bare play() after session restore must not leave Sonora at unity gain.
                            svc.ReapplyOutputVolume();
                            svc.Play();
                            return Task.CompletedTask;
                        });
                    break;
                case "pause":
                    _ = RunEngineCommandAsync(
                        SonoraPlaybackError.OperationUnknown,
                        trackId: null,
                        static (svc, _) =>
                        {
                            svc.Pause();
                            return Task.CompletedTask;
                        });
                    break;
                case "stop":
                    _ = RunEngineCommandAsync(
                        SonoraPlaybackError.OperationUnknown,
                        trackId: null,
                        static (svc, _) =>
                        {
                            svc.Stop();
                            return Task.CompletedTask;
                        });
                    break;
                case "seek":
                    if (TryReadDouble(message, "position", out double position))
                    {
                        double seekPosition = position;
                        _ = RunEngineCommandAsync(
                            SonoraPlaybackError.OperationSeek,
                            trackId: service.CurrentTrackId,
                            (svc, _) =>
                            {
                                if (!svc.HasSource)
                                {
                                    throw new InvalidOperationException(
                                        "No audio source is loaded yet. Wait for load to finish or load the track again.");
                                }

                                svc.Seek(TimeSpan.FromSeconds(Math.Max(0, seekPosition)));
                                return Task.CompletedTask;
                            });
                    }
                    break;
                // "volume" handled above (before availability gate).
                case "crossfade":
                    if (TryReadDouble(message, "seconds", out double seconds))
                    {
                        service.SetCrossfadeDuration(TimeSpan.FromSeconds(Math.Clamp(seconds, 0, 30)));
                    }
                    break;
                case "dsp":
                    ApplyDspCommand(message);
                    break;
                case "listDevices":
                    PostDevices();
                    break;
                case "setOutputDevice":
                    _ = SetOutputDeviceAsync(ReadString(message, "deviceId"));
                    break;
                case "configureOutput":
                    _ = ConfigureOutputAsync(
                        ReadString(message, "mode"),
                        ReadString(message, "exclusiveFallback"));
                    break;
                case "snapshot":
                    PostSnapshot(service.CaptureSnapshot(service.Commands.Current));
                    break;
                default:
                    PostError(
                        service.Commands.Current,
                        SonoraPlaybackError.OperationUnknown,
                        trackId: null,
                        new InvalidOperationException($"Unknown Sonora action '{action}'."));
                    break;
            }
        }

        private static void ApplyDspCommand(JsonElement message)
        {
            if (service is null)
            {
                return;
            }

            float preampDb = 0f;
            if (TryReadDouble(message, "preampDb", out double preamp))
            {
                preampDb = (float)Math.Clamp(preamp, -24, 24);
            }

            bool eqEnabled = message.TryGetProperty("equalizerEnabled", out JsonElement eqEn)
                && eqEn.ValueKind == JsonValueKind.True;

            List<float> gains = [];
            if (message.TryGetProperty("equalizerGains", out JsonElement gainsElement)
                && gainsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement gain in gainsElement.EnumerateArray())
                {
                    if (gain.TryGetDouble(out double db))
                    {
                        gains.Add((float)Math.Clamp(db, -12, 12));
                    }
                }
            }

            bool limiterEnabled = !message.TryGetProperty("limiterEnabled", out JsonElement lim)
                || lim.ValueKind != JsonValueKind.False;

            service.ApplyDsp(preampDb, eqEnabled, gains, limiterEnabled);
        }

        private static Task RunEngineCommandAsync(
            string operation,
            string? trackId,
            Func<SonoraPlaybackService, CancellationToken, Task> action)
        {
            if (service is null)
            {
                return Task.CompletedTask;
            }

            SonoraPlaybackService svc = service;
            return RunEngineCommandCoreAsync(svc, operation, trackId, action);
        }

        private static async Task RunEngineCommandCoreAsync(
            SonoraPlaybackService svc,
            string operation,
            string? trackId,
            Func<SonoraPlaybackService, CancellationToken, Task> action)
        {
            await EngineCommandGate.WaitAsync().ConfigureAwait(false);
            try
            {
                await action(svc, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                PostError(ex, fallbackOperation: operation, fallbackTrackId: trackId);
            }
            finally
            {
                EngineCommandGate.Release();
            }
        }

        private static async Task LoadAsync(
            string? trackId,
            bool play,
            double positionSeconds,
            double? volumeLinear)
        {
            if (service is null || string.IsNullOrWhiteSpace(trackId))
            {
                return;
            }

            await EngineCommandGate.WaitAsync().ConfigureAwait(false);
            try
            {
                if (volumeLinear is double explicitVolume)
                {
                    RememberAndApplyVolume(explicitVolume);
                }
                else
                {
                    ApplyRememberedVolumeToService();
                }

                await service.LoadTrackAsync(trackId).ConfigureAwait(false);
                // A newer load/skip may have superseded this request while LoadAsync was in flight.
                if (!string.Equals(service.CurrentTrackId, trackId, StringComparison.Ordinal)
                    || !service.HasSource)
                {
                    return;
                }

                // Load can recreate output paths; keep EMP gain authoritative before audible Play.
                service.ReapplyOutputVolume();

                if (positionSeconds > 0)
                {
                    service.Seek(TimeSpan.FromSeconds(positionSeconds));
                }

                if (play)
                {
                    service.Play();
                }
            }
            catch (Exception ex)
            {
                PostError(ex, fallbackOperation: SonoraPlaybackError.OperationLoad, fallbackTrackId: trackId);
            }
            finally
            {
                EngineCommandGate.Release();
            }
        }

        private static void RememberAndApplyVolume(double volumeLinear)
        {
            // EMP sends linear 0–1 already (after UI power curve) when using Sonora.
            float clamped = OutputVolume.Remember((float)volumeLinear);
            if (service is not null && service.IsInitialized)
            {
                service.SetVolume(clamped);
            }
        }

        private static void ApplyRememberedVolumeToService()
        {
            if (service is null || !service.IsInitialized)
            {
                return;
            }

            SonoraPlaybackService svc = service;
            _ = OutputVolume.TryApplyExplicit(svc.SetVolume);
        }

        private static async Task PreloadAsync(string? trackId)
        {
            if (service is null || string.IsNullOrWhiteSpace(trackId))
            {
                return;
            }

            await EngineCommandGate.WaitAsync().ConfigureAwait(false);
            try
            {
                await service.PreloadNextAsync(trackId).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                PostError(ex, fallbackOperation: SonoraPlaybackError.OperationPreload, fallbackTrackId: trackId);
            }
            finally
            {
                EngineCommandGate.Release();
            }
        }

        private static void OnSnapshot(SonoraPlaybackSnapshot snapshot)
        {
            if (snapshot.Generation < lastPublishedGeneration)
            {
                return;
            }

            lastPublishedGeneration = snapshot.Generation;
            PostSnapshot(snapshot);
        }

        private static void OnTransitioned(SonoraTrackTransitionInfo info)
        {
            postMessage?.Invoke(new
            {
                type = "sonora",
                kind = "transitioned",
                generation = info.Generation,
                previousTrackId = info.PreviousTrackId,
                nextTrackId = info.NextTrackId,
                previousPath = info.PreviousPath,
                nextPath = info.NextPath,
                previousDuration = info.PreviousDuration.TotalSeconds,
                transitionId = info.TransitionId
            });
        }

        private static void OnCompleted(long generation) =>
            postMessage?.Invoke(new { type = "sonora", kind = "completed", generation });

        private static void OnError(long generation, Exception ex) =>
            PostError(generation, SonoraPlaybackError.OperationUnknown, trackId: null, ex);

        private static void OnOutputDeviceChanged(OutputDeviceChangedEventArgs e) =>
            postMessage?.Invoke(new
            {
                type = "sonora",
                kind = "outputDeviceChanged",
                preferredDeviceId = e.PreferredDeviceId,
                activeDeviceId = e.ActiveDeviceId,
                status = e.Status.ToString(),
                reason = e.Reason.ToString(),
                recoveryIntent = e.RecoveryIntent.ToString()
            });

        private static void OnOutputDevicesChanged() => PostDevices();

        private static void OnOutputConfigurationChanged() => PostDevices();

        private static async Task SetOutputDeviceAsync(string? deviceId)
        {
            if (service is null)
            {
                return;
            }

            await EngineCommandGate.WaitAsync().ConfigureAwait(false);
            try
            {
                // null / empty = follow Windows default render endpoint.
                string? id = string.IsNullOrWhiteSpace(deviceId) ? null : deviceId;
                // No-op when already preferred — SetOutputDevice can re-fire device events and
                // the UI refresh path would otherwise storm the WebView.
                if (string.Equals(service.PreferredOutputDeviceId, id, StringComparison.Ordinal))
                {
                    return;
                }

                await service.SetOutputDeviceAsync(id).ConfigureAwait(false);
                PostDevices();
            }
            catch (Exception ex)
            {
                PostError(ex, fallbackOperation: SonoraPlaybackError.OperationOutputDevice, fallbackTrackId: null);
            }
            finally
            {
                EngineCommandGate.Release();
            }
        }

        private static async Task ConfigureOutputAsync(string? mode, string? exclusiveFallback)
        {
            if (service is null)
            {
                return;
            }

            await EngineCommandGate.WaitAsync().ConfigureAwait(false);
            try
            {
                AudioOutputConfiguration configuration = SonoraOutputModeMapping.FromUi(mode, exclusiveFallback);
                await service.ConfigureOutputAsync(configuration).ConfigureAwait(false);
                PostDevices();
            }
            catch (Exception ex)
            {
                PostError(ex, fallbackOperation: SonoraPlaybackError.OperationOutputDevice, fallbackTrackId: null);
            }
            finally
            {
                EngineCommandGate.Release();
            }
        }

        private static void PostDevices()
        {
            if (service is null)
            {
                return;
            }

            SonoraPlaybackService svc = service;
            IReadOnlyList<AudioOutputDevice> devices = svc.GetOutputDevices();
            postMessage?.Invoke(new
            {
                type = "sonora",
                kind = "devices",
                preferredDeviceId = svc.PreferredOutputDeviceId,
                activeDeviceId = svc.ActiveOutputDeviceId,
                requestedOutputMode = SonoraOutputModeMapping.ToUiMode(svc.OutputConfiguration.Mode),
                effectiveOutputMode = SonoraOutputModeMapping.ToUiMode(svc.EffectiveOutputMode),
                outputFallbackReason = SonoraOutputModeMapping.ToUiFallbackReason(svc.OutputFallbackReason),
                devices = devices
                    .Where(static d => d.State == AudioDeviceState.Active)
                    .Select(static d => new
                    {
                        id = d.Id,
                        name = d.Name,
                        isDefault = d.IsDefault,
                        state = d.State.ToString()
                    })
                    .ToArray()
            });
        }

        private static void PostSnapshot(SonoraPlaybackSnapshot snapshot) =>
            postMessage?.Invoke(new
            {
                type = "sonora",
                kind = "snapshot",
                generation = snapshot.Generation,
                state = snapshot.State.ToString(),
                trackId = snapshot.TrackId,
                nextTrackId = snapshot.NextTrackId,
                sourcePath = snapshot.SourcePath,
                position = snapshot.Position.TotalSeconds,
                bufferedPosition = snapshot.BufferedPosition.TotalSeconds,
                duration = snapshot.Duration.TotalSeconds,
                hasKnownDuration = snapshot.HasKnownDuration,
                volume = snapshot.Volume,
                crossfadeSeconds = snapshot.CrossfadeDuration.TotalSeconds,
                playing = snapshot.State == global::Sonora.Audio.Formats.PlaybackState.Playing,
                preferredDeviceId = service?.PreferredOutputDeviceId,
                activeDeviceId = service?.ActiveOutputDeviceId,
                requestedOutputMode = service is null
                    ? null
                    : SonoraOutputModeMapping.ToUiMode(service.OutputConfiguration.Mode),
                effectiveOutputMode = service is null
                    ? null
                    : SonoraOutputModeMapping.ToUiMode(service.EffectiveOutputMode),
                outputFallbackReason = service is null
                    ? null
                    : SonoraOutputModeMapping.ToUiFallbackReason(service.OutputFallbackReason)
            });

        private static void PostAvailability(bool available) =>
            postMessage?.Invoke(new { type = "sonora", kind = "available", available });

        private static void PostError(Exception exception, string? fallbackOperation = null, string? fallbackTrackId = null)
        {
            if (exception is SonoraCommandException command)
            {
                PostError(command.Generation, command.Operation, command.TrackId, command.InnerException ?? command);
                return;
            }

            long generation = service?.Commands.Current ?? 0;
            PostError(
                generation,
                fallbackOperation ?? SonoraPlaybackError.OperationUnknown,
                fallbackTrackId,
                exception);
        }

        private static void PostError(long generation, string operation, string? trackId, Exception exception)
        {
            // Full diagnostics for decoder investigations — never sent to the WebView as-is.
            System.Diagnostics.Debug.WriteLine(
                $"[EMP Sonora] error op={operation} gen={generation} track={trackId}: {exception}");
            if (exception.InnerException is not null)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EMP Sonora] inner: {exception.InnerException.GetType().FullName}: {exception.InnerException.Message}");
            }

            string message = SonoraPlaybackError.UserMessage(operation, exception);
            bool affectsTransport = SonoraPlaybackError.AffectsTransport(operation);
            postMessage?.Invoke(new
            {
                type = "sonora",
                kind = "error",
                generation,
                operation,
                trackId,
                message,
                title = SonoraPlaybackError.TitleFor(operation),
                affectsTransport
            });
        }

        private static string? ReadTrackId(JsonElement message) => ReadString(message, "trackId");

        private static string? ReadString(JsonElement message, string name) =>
            message.TryGetProperty(name, out JsonElement value)
            && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;

        private static bool TryReadDouble(JsonElement message, string name, out double value)
        {
            value = 0;
            if (!message.TryGetProperty(name, out JsonElement element))
            {
                return false;
            }

            if (element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out value))
            {
                return true;
            }

            if (element.ValueKind == JsonValueKind.String
                && double.TryParse(element.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value))
            {
                return true;
            }

            return false;
        }
    }
}

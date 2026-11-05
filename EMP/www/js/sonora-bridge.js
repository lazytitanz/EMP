(() => {
  const EmpSonora = {
    available: false,
    generation: 0,
    snapshot: null,
    devices: [],
    preferredDeviceId: null,
    activeDeviceId: null,
    listeners: new Set(),

    usesLocal() {
      // Phase 6b: Sonora is the sole local PCM backend whenever the host is available.
      return Boolean(this.available);
    },

    onChange(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },

    notify() {
      for (const listener of this.listeners) {
        try {
          listener(this.snapshot);
        } catch {
          // UI listeners must not break transport.
        }
      }
    },

    command(action, extra = {}) {
      if (!window.chrome?.webview?.postMessage) {
        return;
      }
      window.chrome.webview.postMessage({
        type: "sonora",
        action,
        ...extra
      });
    },

    load(trackId, { play = false, position = 0, volume } = {}) {
      // Host runs volume → load → optional seek → optional play as one async pipeline.
      // Separate play/seek commands race LoadAsync and bump the generation gate.
      const payload = {
        trackId,
        play: Boolean(play),
        position: Number(position) || 0
      };
      if (typeof volume === "number" && Number.isFinite(volume)) {
        payload.volume = Math.max(0, Math.min(1, volume));
      }
      this.command("load", payload);
    },

    preloadNext(trackId) {
      this.command("preloadNext", { trackId });
    },

    clearNext() {
      this.command("clearNext");
    },

    play() {
      this.command("play");
    },

    pause() {
      this.command("pause");
    },

    stop() {
      this.command("stop");
    },

    seek(position) {
      this.command("seek", { position: Number(position) || 0 });
    },

    volume(linear01) {
      this.command("volume", { volume: Math.max(0, Math.min(1, Number(linear01) || 0)) });
    },

    crossfade(seconds) {
      this.command("crossfade", { seconds: Math.max(0, Number(seconds) || 0) });
    },

    dsp({ preampDb = 0, equalizerEnabled = false, equalizerGains = [], limiterEnabled = true } = {}) {
      this.command("dsp", {
        preampDb,
        equalizerEnabled: Boolean(equalizerEnabled),
        equalizerGains: Array.isArray(equalizerGains) ? equalizerGains : [],
        limiterEnabled: limiterEnabled !== false
      });
    },

    listDevices() {
      this.command("listDevices");
    },

    setOutputDevice(deviceId) {
      this.command("setOutputDevice", {
        deviceId: typeof deviceId === "string" ? deviceId : ""
      });
    },

    configureOutput({ mode = "shared", exclusiveFallback = "shared" } = {}) {
      this.command("configureOutput", {
        mode: mode === "exclusive" ? "exclusive" : "shared",
        exclusiveFallback: exclusiveFallback === "none" ? "none" : "shared"
      });
    },

    requestSnapshot() {
      this.command("snapshot");
    },

    handleHostMessage(message) {
      if (!message || message.type !== "sonora") {
        return;
      }

      if (message.kind === "available") {
        this.available = Boolean(message.available);
        window.__emp = window.__emp || {};
        window.__emp.sonoraAvailable = this.available;
        // Do not listDevices here — host already posts devices on Attach/hello/Republish.
        // Requesting again re-enters refresh → setOutputDevice feedback.
        window.dispatchEvent(new CustomEvent("emp-sonora", { detail: message }));
        return;
      }

      if (message.kind === "devices") {
        this.devices = Array.isArray(message.devices) ? message.devices : [];
        this.preferredDeviceId = message.preferredDeviceId ?? null;
        this.activeDeviceId = message.activeDeviceId ?? null;
        window.dispatchEvent(new CustomEvent("emp-sonora", { detail: message }));
        return;
      }

      if (message.kind === "outputDeviceChanged") {
        this.preferredDeviceId = message.preferredDeviceId ?? null;
        this.activeDeviceId = message.activeDeviceId ?? null;
        window.dispatchEvent(new CustomEvent("emp-sonora", { detail: message }));
        return;
      }

      const generation = Number(message.generation) || 0;
      if (generation < this.generation && message.kind !== "error") {
        return;
      }
      if (generation > this.generation) {
        this.generation = generation;
      }

      if (message.kind === "snapshot") {
        this.snapshot = message;
        if (message.preferredDeviceId !== undefined) {
          this.preferredDeviceId = message.preferredDeviceId;
        }
        if (message.activeDeviceId !== undefined) {
          this.activeDeviceId = message.activeDeviceId;
        }
        this.notify();
      }

      window.dispatchEvent(new CustomEvent("emp-sonora", { detail: message }));
    }
  };

  window.EmpSonora = EmpSonora;
  window.addEventListener("emp-sonora-host", (event) => EmpSonora.handleHostMessage(event.detail));

  // Attach can post availability before this script runs — ask the host to re-announce.
  if (window.chrome?.webview?.postMessage) {
    window.chrome.webview.postMessage({ type: "sonora", action: "hello" });
  }
})();

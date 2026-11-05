(() => {
  const OPERATIONS = Object.freeze({
    load: "load",
    preload: "preload",
    seek: "seek",
    outputDevice: "outputDevice",
    play: "play",
    unknown: "unknown"
  });

  function affectsTransport(operation) {
    const op = typeof operation === "string" ? operation : "";
    return op === OPERATIONS.load
      || op === OPERATIONS.play
      || op === OPERATIONS.seek
      || op === OPERATIONS.unknown
      || !op;
  }

  function isStale(errorGeneration, currentGeneration) {
    const errorGen = Number(errorGeneration) || 0;
    const currentGen = Number(currentGeneration) || 0;
    return errorGen > 0 && errorGen < currentGen;
  }

  function sanitizeMessage(message) {
    if (!message || typeof message !== "string") {
      return "";
    }
    let text = message.trim();
    text = text.replace(/['"]?[A-Za-z]:\\.+?\.(?:mp3|m4a|flac|wav|ogg|oga|opus|wma|aiff|aif|alac|webm|aac)['"]?/gi, "this file");
    text = text.replace(/\b[A-Za-z]:\\[^\r\n]*/g, "this file");
    text = text.replace(/\\\\[^\s"']+/g, "this file");
    text = text.replace(/source 'this file'/gi, "source");
    text = text.replace(/source this file/gi, "source");
    text = text.replace(/\s{2,}/g, " ").trim().replace(/^['".\s]+|['".\s]+$/g, "");
    if (/[A-Za-z]:\\/.test(text) || text.startsWith("\\\\")) {
      return "";
    }
    return text.length > 160 ? "" : text;
  }

  function titleFor(operation) {
    if (operation === OPERATIONS.preload) {
      return "Couldn't prepare next track";
    }
    if (operation === OPERATIONS.outputDevice) {
      return "Audio output";
    }
    return "Couldn't play track";
  }

  const api = {
    OPERATIONS,
    affectsTransport,
    isStale,
    sanitizeMessage,
    titleFor
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalThis.EmpSonoraPlaybackErrors = api;
})();

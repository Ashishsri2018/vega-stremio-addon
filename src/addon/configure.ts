const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Configure Vega Streams</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0d1117; color: #e6edf3;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    width: min(92vw, 460px); padding: 32px; border-radius: 16px;
    background: #161b22; border: 1px solid #30363d;
  }
  h1 { margin: 0 0 4px; font-size: 1.4rem; }
  .sub { margin: 0 0 24px; color: #8b949e; font-size: 0.9rem; }
  label { display: block; margin: 0 0 16px; font-size: 0.9rem; color: #c9d1d9; }
  select {
    display: block; width: 100%; margin-top: 6px; padding: 9px 10px; border-radius: 8px;
    border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 1rem;
  }
  .check { display: flex; gap: 8px; align-items: center; }
  .check input { width: 16px; height: 16px; }
  .install {
    display: block; margin: 24px 0 16px; padding: 12px; border-radius: 8px;
    background: #7b5bf2; color: #fff; text-align: center; font-weight: 600;
    text-decoration: none;
  }
  .install.disabled { opacity: 0.4; pointer-events: none; }
  .url-row { display: flex; gap: 8px; }
  .url-row input {
    flex: 1; min-width: 0; padding: 9px 10px; border-radius: 8px;
    border: 1px solid #30363d; background: #0d1117; color: #8b949e; font-size: 0.85rem;
  }
  .url-row button {
    padding: 0 14px; border-radius: 8px; border: 1px solid #30363d;
    background: #21262d; color: #e6edf3; cursor: pointer;
  }
  .error { margin: 0 0 12px; color: #f85149; font-size: 0.85rem; }
  .note { margin: 16px 0 0; color: #6e7681; font-size: 0.78rem; }
</style>
</head>
<body>
<main>
  <h1>Vega Streams</h1>
  <p class="sub">Pick your stream filters, then install the add-on URL shown below. Your settings travel in the URL and are not stored on the server.</p>

  <label>Maximum resolution
    <select id="maxRes">
      <option value="">Any</option>
      <option value="480">480p</option>
      <option value="720">720p</option>
      <option value="1080">1080p</option>
      <option value="2160">4K</option>
    </select>
  </label>

  <label>Minimum resolution
    <select id="minRes">
      <option value="">Any</option>
      <option value="480">480p</option>
      <option value="720">720p</option>
      <option value="1080">1080p</option>
      <option value="2160">4K</option>
    </select>
  </label>

  <label class="check">
    <input type="checkbox" id="includeUnknown" checked />
    Include streams with unknown resolution
  </label>

  <p class="error" id="error" hidden></p>

  <a class="install" id="install" href="#">Install in Stremio</a>

  <div class="url-row">
    <input id="url" readonly />
    <button id="copy" type="button">Copy</button>
  </div>

  <p class="note">Open this page again from the add-on's gear icon in Stremio to change your filters.</p>
</main>
<script>
  (function () {
    var maxRes = document.getElementById("maxRes");
    var minRes = document.getElementById("minRes");
    var includeUnknown = document.getElementById("includeUnknown");
    var install = document.getElementById("install");
    var urlInput = document.getElementById("url");
    var copy = document.getElementById("copy");
    var error = document.getElementById("error");

    function toBase64Url(text) {
      return btoa(text).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    }
    function fromBase64Url(segment) {
      var text = segment.replace(/-/g, "+").replace(/_/g, "/");
      while (text.length % 4) text += "=";
      return atob(text);
    }

    try {
      var segment = location.pathname.split("/").filter(Boolean)[0];
      if (segment && segment !== "configure") {
        var cfg = JSON.parse(fromBase64Url(segment));
        if (cfg && cfg.v === 1) {
          if (typeof cfg.maxRes === "number") maxRes.value = String(cfg.maxRes);
          if (typeof cfg.minRes === "number") minRes.value = String(cfg.minRes);
          includeUnknown.checked = cfg.includeUnknown !== false;
        }
      }
    } catch (ignored) {}

    function update() {
      var payload = { v: 1 };
      if (maxRes.value) payload.maxRes = Number(maxRes.value);
      if (minRes.value) payload.minRes = Number(minRes.value);
      if (!includeUnknown.checked) payload.includeUnknown = false;

      var invalid = payload.maxRes && payload.minRes && payload.minRes > payload.maxRes;
      error.hidden = !invalid;
      error.textContent = invalid ? "Minimum resolution cannot be higher than maximum." : "";
      install.classList.toggle("disabled", invalid);
      if (invalid) {
        install.removeAttribute("href");
        urlInput.value = "";
        return;
      }

      var isDefault =
        payload.maxRes === undefined &&
        payload.minRes === undefined &&
        payload.includeUnknown !== false;
      var path = isDefault
        ? "/manifest.json"
        : "/" + toBase64Url(JSON.stringify(payload)) + "/manifest.json";
      urlInput.value = location.origin + path;
      install.href = "stremio://" + location.host + path;
    }

    maxRes.addEventListener("change", update);
    minRes.addEventListener("change", update);
    includeUnknown.addEventListener("change", update);

    copy.addEventListener("click", function () {
      if (!urlInput.value) return;
      var done = function () {
        copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = "Copy"; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(urlInput.value).then(done, function () {
          urlInput.select();
          document.execCommand("copy");
          done();
        });
      } else {
        urlInput.select();
        document.execCommand("copy");
        done();
      }
    });

    update();
  })();
</script>
</body>
</html>
`;

export function renderConfigurePage(): string {
  return PAGE;
}

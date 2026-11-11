/* Minimal headless-Chrome driver over the DevTools protocol (Node >= 22 has a global WebSocket).
 * Used instead of `chrome --screenshot`, which hangs on Linux boxes without D-Bus. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((b) => {
    try { execFileSync("which", [b], { stdio: "ignore" }); return true; } catch (e) { return false; }
  }) || null;
}

async function launch(chrome) {
  chrome = chrome || findChrome();
  if (!chrome) throw new Error("No Chrome/Chromium found (set CHROME=...)");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ub-cdp-"));
  const proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--remote-debugging-port=0", "--allow-file-access-from-files", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("Chrome did not start")), 30000);
    proc.stderr.on("data", (d) => { buf += d; const m = buf.match(/ws:\/\/\S+/); if (m) { clearTimeout(t); resolve(m[0]); } });
    proc.on("error", (e) => { clearTimeout(t); reject(e); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(), waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.j(new Error(msg.error.message)) : p.r(msg.result); }
    else if (msg.method) for (const w of waiters.slice()) if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId)) { waiters.splice(waiters.indexOf(w), 1); w.r(msg.params); }
  };
  const send = (method, params, sessionId) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });
  const once = (method, sessionId) => new Promise((r) => waiters.push({ method, sessionId, r }));

  async function newPage(width, height) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    const page = {
      send: (m, p) => send(m, p, sessionId),
      async addInitScript(source) { await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId); },
      async goto(url) { const loaded = once("Page.loadEventFired", sessionId); await send("Page.navigate", { url }, sessionId); await loaded; },
      async eval(expression) {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error("page eval failed: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        return r.result.value;
      },
      async mouseMove(x, y) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId); },
      async screenshot(clip) {
        const shot = await send("Page.captureScreenshot", { format: "png", clip: Object.assign({ x: 0, y: 0, scale: 1 }, clip) }, sessionId);
        return Buffer.from(shot.data, "base64");
      },
      async close() { await send("Target.closeTarget", { targetId }); }
    };
    return page;
  }
  async function close() { try { ws.close(); } catch (e) {} try { proc.kill("SIGKILL"); } catch (e) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
  return { newPage, close };
}

module.exports = { launch, findChrome };

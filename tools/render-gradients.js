#!/usr/bin/env node
/*
 * Visual check for gradients: renders gradients_compare.png with headless Chrome (canvas).
 *   Column 1  "Figma (expected)": per-pixel evaluation of the ORIGINAL Figma paint
 *             (gradientTransform applied to the layer's unit box, raw Figma stops).
 *   Column 2  "AE native (from JSON)": what a G-Fill with our exported start/end points and
 *             split stops renders (linear projection / circular radial), stops via UBGeom.sampleStops.
 *   Column 3  "Ramp fallback": the 2-colour Gradient Ramp used when presets are unavailable.
 * Each row reports the mean per-channel difference (0..255) between column 1 and 2/3.
 * Usage: node tools/render-gradients.js [out.png]   (needs google-chrome / chromium in PATH or CHROME env)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const G = require("../shared/geom.js");
const { createUBSerializer } = require("../figma-plugin/src/serializer.js");
const S = require("../tests/helpers/figma-stub.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "docs", "gradients_compare.png"));
const W = 260, H = 180;
const st = (p, r, g, b, a = 1) => ({ position: p, color: { r, g, b, a } });
const T = (m) => [[m[0], m[2], m[4]], [m[1], m[3], m[5]]];
// Figma-style gradientTransform from unit-space handle points (like the Figma UI produces)
function linearT(p0, p1) { const dx = p1[0] - p0[0], dy = p1[1] - p0[1]; return T(G.invert([dx, dy, -dy, dx, p0[0] + 0.5 * dy, p0[1] - 0.5 * dx])); }
function radialT(c, rx, ry, rotDeg) { const r = (rotDeg || 0) * Math.PI / 180; const ax = [Math.cos(r) * rx, Math.sin(r) * rx], ay = [-Math.sin(r) * ry, Math.cos(r) * ry];
  return T(G.invert([ax[0] * 2, ax[1] * 2, ay[0] * 2, ay[1] * 2, c[0] - ax[0] - ay[0], c[1] - ax[1] - ay[1]])); }

const CASES = [
  { title: "Linear L→R, 3 stops", w: 200, h: 120, rel: [1, 0, 0, 1, 30, 30], shape: "rect", type: "GRADIENT_LINEAR", gt: [[1, 0, 0], [0, 1, 0]], stops: [st(0, 0.39, 0.4, 0.95), st(0.55, 0.85, 0.35, 0.85), st(1, 1, 0.62, 0.3)] },
  { title: "Linear diagonal on layer rotated 30°", w: 160, h: 90, rel: S.rot(30, 80, 20), shape: "rect", type: "GRADIENT_LINEAR", gt: linearT([0, 0], [1, 1]), stops: [st(0, 0.1, 0.8, 0.6), st(1, 0.1, 0.2, 0.7)] },
  { title: "Linear, layer scaled 1.6×0.6 + rotated −20°", w: 120, h: 160, rel: G.multiply(S.rot(-20, 40, 90), [1.6, 0, 0, 0.6, 0, 0]), shape: "rect", type: "GRADIENT_LINEAR", gt: linearT([0.2, 0.1], [0.7, 0.9]), stops: [st(0, 1, 0.3, 0.3), st(0.5, 1, 0.9, 0.3), st(1, 0.3, 0.6, 1)] },
  { title: "Linear with alpha stops (fade)", w: 200, h: 120, rel: [1, 0, 0, 1, 30, 30], shape: "rect", type: "GRADIENT_LINEAR", gt: linearT([0.5, 0], [0.5, 1]), stops: [st(0, 0.2, 0.3, 0.9, 1), st(0.6, 0.2, 0.3, 0.9, 0.4), st(1, 0.9, 0.2, 0.4, 0)] },
  { title: "Unsorted stops input (ordering)", w: 200, h: 120, rel: [1, 0, 0, 1, 30, 30], shape: "rect", type: "GRADIENT_LINEAR", gt: [[1, 0, 0], [0, 1, 0]], stops: [st(1, 0, 0, 0), st(0, 1, 1, 1), st(0.3, 1, 0.2, 0.2), st(0.7, 0.2, 0.2, 1)] },
  { title: "8 stops (rainbow)", w: 200, h: 120, rel: [1, 0, 0, 1, 30, 30], shape: "rect", type: "GRADIENT_LINEAR", gt: linearT([0, 0.2], [1, 0.8]), stops: [[1, 0, 0], [1, 0.5, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [0.5, 0, 1], [1, 0, 1]].map((c, i) => st(i / 7, c[0], c[1], c[2])) },
  { title: "Radial, circular", w: 140, h: 140, rel: [1, 0, 0, 1, 60, 20], shape: "ellipse", type: "GRADIENT_RADIAL", gt: [[1, 0, 0], [0, 1, 0]], stops: [st(0, 1, 1, 1), st(0.6, 0.55, 0.75, 1), st(1, 0.2, 0.3, 0.9, 0)] },
  { title: "Radial off-centre highlight", w: 200, h: 140, rel: [1, 0, 0, 1, 30, 20], shape: "rect", type: "GRADIENT_RADIAL", gt: radialT([0.3, 0.35], 0.5 * 140 / 200, 0.5, 0), stops: [st(0, 1, 0.95, 0.7), st(1, 0.9, 0.3, 0.2)] },
  { title: "Radial elliptical (LIMITATION: AE is circular)", w: 220, h: 80, rel: [1, 0, 0, 1, 20, 50], shape: "ellipse", type: "GRADIENT_RADIAL", gt: [[1, 0, 0], [0, 1, 0]], stops: [st(0, 1, 0.9, 0.5, 1), st(1, 1, 0.5, 0.2, 0)] }
];

(async () => {
  const rows = [];
  for (const c of CASES) {
    const child = S.node(c.shape === "ellipse" ? "ELLIPSE" : "RECTANGLE", { name: c.title, width: c.w, height: c.h, rel: c.rel, fills: [S.gradient(c.type, c.gt, c.stops)] });
    const frame = S.finalize(S.node("FRAME", { name: "case", width: W, height: H, rel: [1, 0, 0, 1, 0, 0] }, [child]));
    const { job } = await createUBSerializer(S.figmaApi, G, {}).serialize([frame], {});
    const n = job.comps[0].root.children[0];
    rows.push({
      title: c.title, shape: c.shape, w: c.w, h: c.h,
      layerMatrix: G.fromFigma(child.absoluteTransform),           // figma truth
      figma: { type: c.type, gt: G.fromFigma(c.gt), stops: c.stops },
      json: { kind: n.fills[0].kind, handles: n.fills[0].handles, handlesComp: n.fills[0].handlesComp, split: n.fills[0].split, ramp: G.rampFallback(n.fills[0].handles, c.stops), matrixComp: n.transform.matrixComp }
    });
  }
  const geomSrc = fs.readFileSync(path.join(ROOT, "shared", "geom.js"), "utf8");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:16px;background:#1d1d1f;color:#e6e6e6;font:13px/1.4 "Segoe UI",Arial,sans-serif}
  h1{font-size:16px;margin:0 0 4px} .sub{color:#9a9a9a;margin-bottom:12px;font-size:12px}
  table{border-collapse:collapse} td,th{padding:6px 8px;vertical-align:top} th{font-weight:600;color:#bbb;text-align:left}
  canvas{display:block;border:1px solid #333} .t{width:190px;font-weight:600} .m{color:#9a9a9a;font-size:12px;font-weight:400;margin-top:6px}
  .ok{color:#59d68f}.bad{color:#ff8a65}</style></head><body>
  <h1>Uiscore Bridge — gradients: Figma expected vs reconstructed from job JSON</h1>
  <div class="sub">Column 1 evaluates the original Figma paint per pixel. Column 2 renders what After Effects' G-Fill draws from the exported start/end points + stops. Column 3 is the 2-colour Gradient Ramp fallback. Δ = mean abs difference per channel (0–255) inside the shape.</div>
  <table id="t"><tr><th></th><th>Figma (expected)</th><th>AE native G-Fill (from JSON)</th><th>Gradient Ramp fallback</th></tr></table>
  <script>${geomSrc}</script>
  <script>
  const G = UBGeom, W=${W}, H=${H}, ROWS=${JSON.stringify(rows)};
  function figmaSample(stops, t){ const s=stops.map((x,i)=>({p:Math.min(1,Math.max(0,x.position)),c:x.color,i})).sort((a,b)=>a.p-b.p||a.i-b.i);
    if(t<=s[0].p) return [s[0].c.r,s[0].c.g,s[0].c.b,s[0].c.a]; const L=s[s.length-1]; if(t>=L.p) return [L.c.r,L.c.g,L.c.b,L.c.a];
    for(let i=0;i<s.length-1;i++){const A=s[i],B=s[i+1]; if(t>=A.p&&t<=B.p){const u=B.p-A.p<1e-9?0:(t-A.p)/(B.p-A.p); return ['r','g','b','a'].map(k=>A.c[k]+(B.c[k]-A.c[k])*u);}} return [L.c.r,L.c.g,L.c.b,L.c.a]; }
  function inside(row, p){ const inv=G.invert(row.layerMatrix), q=G.apply(inv,p); const u=q[0]/row.w, v=q[1]/row.h;
    if(row.shape==='ellipse') return (u-.5)*(u-.5)+(v-.5)*(v-.5)<=0.25; return u>=0&&u<=1&&v>=0&&v<=1; }
  function expected(row,p){ const q=G.apply(G.invert(row.layerMatrix),p); const g=G.apply(row.figma.gt,[q[0]/row.w,q[1]/row.h]);
    const t=row.figma.type==='GRADIENT_LINEAR'? g[0] : Math.sqrt((g[0]-.5)**2+(g[1]-.5)**2)*2; return figmaSample(row.figma.stops,t); }
  // AE evaluates the G-Fill in layer space (start/end are shape-group coordinates), then the layer transform maps it.
  function aeNative(row,p){ p=G.apply(G.invert(row.json.matrixComp),p); const h=row.json.handles, s=h.start, e=h.end, dx=e[0]-s[0], dy=e[1]-s[1], L2=dx*dx+dy*dy;
    const t = row.json.kind==='linear' ? ((p[0]-s[0])*dx+(p[1]-s[1])*dy)/L2 : Math.sqrt(((p[0]-s[0])**2+(p[1]-s[1])**2)/L2);
    return G.sampleStops(row.json.split, Math.min(1,Math.max(0,t))); }
  function ramp(row,p){ p=G.apply(G.invert(row.json.matrixComp),p); const r=row.json.ramp, s=r.start, e=r.end, dx=e[0]-s[0], dy=e[1]-s[1], L2=dx*dx+dy*dy;
    let t = r.shape===1 ? ((p[0]-s[0])*dx+(p[1]-s[1])*dy)/L2 : Math.sqrt(((p[0]-s[0])**2+(p[1]-s[1])**2)/L2); t=Math.min(1,Math.max(0,t));
    return [0,1,2].map(k=>r.startColor[k]+(r.endColor[k]-r.startColor[k])*t).concat([1]); }
  function draw(row, fn){ const c=document.createElement('canvas'); c.width=W; c.height=H; const ctx=c.getContext('2d'); const img=ctx.createImageData(W,H); const vals=[];
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ const i=(y*W+x)*4, chk=((x>>3)+(y>>3))&1?0.32:0.22; let rgba=[chk,chk,chk,1], v=null;
      const p=[x+.5,y+.5]; if(inside(row,p)){ v=fn(row,p); const a=v[3]; rgba=[0,1,2].map(k=>v[k]*a+chk*(1-a)).concat([1]); }
      vals.push(v ? rgba : null); img.data[i]=rgba[0]*255; img.data[i+1]=rgba[1]*255; img.data[i+2]=rgba[2]*255; img.data[i+3]=255; }
    ctx.putImageData(img,0,0); return {c, vals}; }
  function diff(a,b){ let s=0,n=0; for(let i=0;i<a.length;i++) if(a[i]&&b[i]){ for(let k=0;k<3;k++) s+=Math.abs(a[i][k]-b[i][k]); n+=3; } return n? s/n*255 : 0; }
  const results=[];
  for(const row of ROWS){ const tr=document.createElement('tr'); const e=draw(row,expected), n=draw(row,aeNative), r=draw(row,ramp);
    const dn=diff(e.vals,n.vals), dr=diff(e.vals,r.vals); results.push({title:row.title, nativeDelta:+dn.toFixed(2), rampDelta:+dr.toFixed(2)});
    const td0=document.createElement('td'); td0.className='t'; td0.innerHTML=row.title+'<div class="m">'+row.figma.stops.length+' stops · '+row.json.kind+'</div>';
    tr.appendChild(td0);
    [[e,null],[n,dn],[r,dr]].forEach(([cv,d])=>{ const td=document.createElement('td'); td.appendChild(cv.c); if(d!==null){ const m=document.createElement('div'); m.className='m '+(d<2?'ok':'bad'); m.textContent='Δ '+d.toFixed(2); td.appendChild(m);} else { const m=document.createElement('div'); m.className='m'; m.textContent='reference'; td.appendChild(m);} tr.appendChild(td); });
    document.getElementById('t').appendChild(tr); }
  const pre=document.createElement('pre'); pre.id='results'; pre.style.display='none'; pre.textContent=JSON.stringify(results); document.body.appendChild(pre);
  </script></body></html>`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ub-grad-"));
  const htmlFile = path.join(tmp, "gradients.html");
  fs.writeFileSync(htmlFile, html);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(htmlFile, OUT.replace(/\.png$/, ".html"));
  const chrome = process.env.CHROME || ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((b) => { try { execFileSync("which", [b], { stdio: "ignore" }); return true; } catch (e) { return false; } });
  if (!chrome) { console.error("No Chrome/Chromium found; open " + OUT.replace(/\.png$/, ".html") + " in a browser instead."); process.exit(2); }
  const height = 110 + CASES.length * (H + 34);
  const { results, png } = await captureWithCDP(chrome, "file://" + htmlFile, 1080, height, path.join(tmp, "profile"));
  fs.writeFileSync(OUT, png);
  fs.writeFileSync(OUT.replace(/\.png$/, ".json"), JSON.stringify(results, null, 2));
  console.log("wrote", OUT);
  for (const r of results) console.log(`  ${r.nativeDelta.toFixed(2).padStart(6)}  native | ${r.rampDelta.toFixed(2).padStart(6)} ramp   ${r.title}`);
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * Drive headless Chrome over the DevTools protocol (Node >= 22 has a global WebSocket).
 * More robust than --screenshot, which hangs on some Linux boxes without D-Bus.
 */
function captureWithCDP(chrome, url, width, height, profile) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const kill = () => { try { proc.kill("SIGKILL"); } catch (e) {} };
    const timer = setTimeout(() => { kill(); reject(new Error("Chrome CDP timeout")); }, 60000);
    let buf = "", started = false;
    proc.stderr.on("data", async (d) => {
      buf += d;
      const m = buf.match(/ws:\/\/\S+/);
      if (!m || started) return;
      started = true;
      try {
        const ws = new WebSocket(m[0]);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const pending = new Map(), waiters = [];
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.j(new Error(msg.error.message)) : p.r(msg.result); }
          else if (msg.method) for (const w of waiters.slice()) if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.r(msg.params); }
        };
        const send = (method, params, sessionId) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });
        const once = (method) => new Promise((r) => waiters.push({ method, r }));
        const { targetId } = await send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
        await send("Page.enable", {}, sessionId);
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        const loaded = once("Page.loadEventFired");
        await send("Page.navigate", { url }, sessionId);
        await loaded;
        const ev = await send("Runtime.evaluate", { expression: "(document.getElementById('results')||{}).textContent || '[]'", returnByValue: true }, sessionId);
        const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
        ws.close(); clearTimeout(timer); kill();
        resolve({ results: JSON.parse(ev.result.value), png: Buffer.from(shot.data, "base64") });
      } catch (e) { clearTimeout(timer); kill(); reject(e); }
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

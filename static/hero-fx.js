/* hero-fx.js - landing-page background: glowing neon ribbons + Matrix-style digital rain.
   Two stacked canvases inside .hero. No dependencies, no inline code (CSP-safe). */
(() => {
  "use strict";

  const hero = document.querySelector(".hero");
  const waveCanvas = document.getElementById("fxWaves");
  const rainCanvas = document.getElementById("fxRain");
  if (!hero || !waveCanvas || !rainCanvas) return;

  const wctx = waveCanvas.getContext("2d");
  const rctx = rainCanvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Half-width katakana + digits + a few symbols that show up in the PII being redacted.
  const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789@$_{}<>=+".split("");
  const FONT_PX = 16;
  const RIBBONS = 6;

  let W = 0, H = 0, dpr = 1, rows = 0;
  let drops = [];

  const rand = (a, b) => a + Math.random() * (b - a);
  const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

  function newDrop(initial) {
    return {
      row: initial ? rand(-rows, rows) : rand(-30, -2),
      speed: rand(0.25, 0.8),           // rows per 1/60 s
      acc: 0,
      active: Math.random() < 0.7,      // not every column rains at once
    };
  }

  function resize() {
    const box = hero.getBoundingClientRect();
    W = Math.max(1, Math.floor(box.width));
    H = Math.max(1, Math.floor(box.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Waves are soft and blurry, so a 1x canvas is plenty (and cheap).
    waveCanvas.width = W;
    waveCanvas.height = H;
    wctx.setTransform(1, 0, 0, 1, 0, 0);

    rainCanvas.width = W * dpr;
    rainCanvas.height = H * dpr;
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rctx.font = `${FONT_PX}px "Courier New", ui-monospace, monospace`;
    rctx.textBaseline = "top";

    rows = Math.ceil(H / FONT_PX);
    const cols = Math.ceil(W / FONT_PX);
    drops = Array.from({ length: cols }, () => newDrop(true));
    if (!running()) renderStill();
  }

  // ------------------------------------------------------------ neon ribbons
  function drawWaves(t) {
    wctx.globalCompositeOperation = "source-over";
    wctx.clearRect(0, 0, W, H);
    wctx.globalCompositeOperation = "lighter";
    wctx.lineJoin = "round";

    const tilt = 0.28;                                     // sweeps from lower-left to upper-right
    for (let k = 0; k < RIBBONS; k++) {
      const frac = 0.3 + (k / (RIBBONS - 1)) * 0.55;
      const phase = k * 1.7;
      const amp1 = H * (0.07 + 0.015 * k);
      const amp2 = H * 0.035;
      const speed = 0.35 + k * 0.07;
      const thick = H * (0.06 + 0.03 * ((k + 1) % 3));

      const top = [], bottom = [];
      for (let x = -20; x <= W + 20; x += 10) {
        const u = x / W;
        const y =
          H * frac - (u - 0.5) * H * tilt +
          Math.sin(u * 3.2 + t * speed + phase) * amp1 +
          Math.sin(u * 7.5 - t * speed * 1.4 + phase * 2) * amp2;
        const w = thick * (0.45 + 0.55 * Math.sin(u * 4 + t * 0.6 + phase) ** 2);
        top.push([x, y]);
        bottom.push([x, y + w]);
      }

      // translucent glassy body between the two edges
      const body = wctx.createLinearGradient(0, 0, W, 0);
      body.addColorStop(0, "rgba(0,255,90,0)");
      body.addColorStop(0.35, "rgba(0,255,90,0.10)");
      body.addColorStop(0.7, "rgba(160,255,40,0.16)");
      body.addColorStop(1, "rgba(0,255,90,0)");
      wctx.beginPath();
      top.forEach(([x, y], i) => (i ? wctx.lineTo(x, y) : wctx.moveTo(x, y)));
      for (let i = bottom.length - 1; i >= 0; i--) wctx.lineTo(bottom[i][0], bottom[i][1]);
      wctx.closePath();
      wctx.fillStyle = body;
      wctx.fill();

      // glowing edge: wide soft pass, then a thin bright core with a yellow-green hot spot
      const edge = wctx.createLinearGradient(0, 0, W, 0);
      const hot = 0.5 + 0.35 * Math.sin(t * 0.5 + phase);
      edge.addColorStop(0, "rgba(0,255,70,0)");
      edge.addColorStop(Math.max(0.05, hot - 0.25), "rgba(0,255,70,0.55)");
      edge.addColorStop(hot, "rgba(220,255,120,0.95)");
      edge.addColorStop(Math.min(0.95, hot + 0.25), "rgba(0,255,70,0.55)");
      edge.addColorStop(1, "rgba(0,255,70,0)");

      wctx.beginPath();
      top.forEach(([x, y], i) => (i ? wctx.lineTo(x, y) : wctx.moveTo(x, y)));
      wctx.strokeStyle = edge;
      wctx.shadowColor = "rgba(0,255,80,0.9)";
      wctx.shadowBlur = 22;
      wctx.lineWidth = 6;
      wctx.globalAlpha = 0.25;
      wctx.stroke();
      wctx.lineWidth = 1.6;
      wctx.globalAlpha = 1;
      wctx.stroke();
      wctx.shadowBlur = 0;
    }
    wctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ digital rain
  function fadeRain(dt) {
    rctx.globalCompositeOperation = "destination-out";
    rctx.fillStyle = `rgba(0,0,0,${1 - Math.pow(0.93, dt)})`;
    rctx.fillRect(0, 0, W, H);
    rctx.globalCompositeOperation = "source-over";
  }

  function stepRain(dt) {
    fadeRain(dt);
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      if (!d.active) {
        if (Math.random() < 0.002 * dt) d.active = true;
        continue;
      }
      d.acc += d.speed * dt;
      while (d.acc >= 1) {
        d.acc -= 1;
        const x = i * FONT_PX;
        // the previous head cools down to normal green...
        if (d.row >= 0 && d.row < rows) {
          const py = d.row * FONT_PX;
          rctx.clearRect(x, py, FONT_PX, FONT_PX);
          rctx.fillStyle = "#00ff55";
          rctx.fillText(glyph(), x, py);
        }
        d.row += 1;
        // ...and the new head is nearly white
        if (d.row >= 0 && d.row < rows) {
          rctx.fillStyle = "#e6ffee";
          rctx.fillText(glyph(), x, d.row * FONT_PX);
        }
      }
      if (d.row > rows + 4) {
        drops[i] = newDrop(false);
        drops[i].active = Math.random() < 0.85;
      }
    }
  }

  // ------------------------------------------------------------ loop
  let raf = 0, last = 0, t = 0, inView = true;
  const running = () => raf !== 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 16.667, 3);   // frames at 60 fps, clamped after tab switches
    last = now;
    t += dt / 60;
    drawWaves(t);
    stepRain(dt);
  }

  function start() {
    if (raf || !inView || document.hidden || reduceMotion.matches) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  // One static picture for people who asked their OS for reduced motion.
  function renderStill() {
    rctx.clearRect(0, 0, W, H);
    for (let i = 0; i < 160; i++) stepRain(1);
    drawWaves(2.5);
  }

  function sync() {
    if (reduceMotion.matches) {
      stop();
      renderStill();
    } else {
      start();
    }
  }

  new ResizeObserver(resize).observe(hero);
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    inView ? start() : stop();
  }).observe(hero);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reduceMotion.addEventListener("change", sync);

  resize();
  sync();
})();

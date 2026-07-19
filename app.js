/* Meditation Analysis — meditation trainer PWA */
(() => {
  "use strict";

  /* ---------------- State ---------------- */

  const state = {
    durationMin: 10,
    gongEnabled: false,
    intervalMin: 5,
    screen: "setup",
  };

  const session = {
    startTime: 0,
    durationSec: 0,
    intervalSec: 0,
    gongEnabled: false,
    touches: [], // seconds elapsed at each "return" touch
    nextGongAt: 0,
    ended: false,
  };

  const HOLD_MS = 1400;
  const TAP_MAX_MS = 500;
  const TAP_MAX_MOVE = 30;
  const HISTORY_KEY = "focusbell_history_v1";

  /* ---------------- Elements ---------------- */

  const el = (id) => document.getElementById(id);
  const screens = {
    setup: el("screen-setup"),
    countdown: el("screen-countdown"),
    session: el("screen-session"),
    summary: el("screen-summary"),
    history: el("screen-history"),
  };

  const durationValueEl = el("duration-value");
  const intervalValueEl = el("interval-value");
  const intervalField = el("interval-field");
  const gongToggle = el("gong-toggle");
  const presetsWrap = el("duration-presets");

  const countdownNumber = el("countdown-number");

  const sessionTimeEl = el("session-time");
  const sessionTotalEl = el("session-total");
  const sessionTouchesEl = el("session-touches");
  const sessionInstructions = el("session-instructions");
  const rippleLayer = el("tap-ripple-layer");
  const holdProgress = el("hold-progress");
  const holdProgressFill = el("hold-progress-fill");

  const summaryDuration = el("summary-duration");
  const summaryTouches = el("summary-touches");
  const summaryAvg = el("summary-avg");
  const summaryTimeline = el("summary-timeline");

  const historyList = el("history-list");
  const historyEmpty = el("history-empty");
  const historyScroll = el("history-scroll");
  const streakValueEl = el("streak-value");
  const calPrevBtn = el("cal-prev");
  const calNextBtn = el("cal-next");
  const calMonthLabel = el("cal-month-label");
  const calendarGrid = el("calendar-grid");
  const chartDuration = el("chart-duration");
  const chartReturns = el("chart-returns");
  const chartRpm = el("chart-rpm");
  const chartAvgGap = el("chart-avg-gap");
  const chartMaxGap = el("chart-max-gap");

  const CHART_LIMIT = 20;

  /* ---------------- Utils ---------------- */

  function fmtTime(totalSec) {
    totalSec = Math.max(0, Math.round(totalSec));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // Session start (t=0) counts as an uncounted boundary for measuring gaps, but
  // never as a "return" itself. The final stretch (last return -> session end)
  // is excluded from the average/rpm so an unfinished stretch of focus never
  // drags those numbers down — but it's exactly what "longest stretch" rewards.
  function computeSessionStats(touches, durationSec) {
    const n = touches.length;
    const lastTouch = n ? touches[n - 1] : 0;
    const avgGap = n ? lastTouch / n : null;
    const rpm = n && lastTouch > 0 ? n / (lastTouch / 60) : 0;

    const bounds = [0, ...touches, durationSec];
    let maxGap = 0;
    for (let i = 1; i < bounds.length; i++) {
      maxGap = Math.max(maxGap, bounds[i] - bounds[i - 1]);
    }

    return { avgGap, maxGap, rpm };
  }

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
    state.screen = name;
  }

  /* ---------------- Audio (synthesized gong) ---------------- */

  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playGong(intensity = 1) {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.5 * intensity;
    master.connect(ctx.destination);

    // Inharmonic partials approximate a bell/gong timbre.
    const fundamental = 165;
    const partials = [1, 1.49, 2.0, 2.72, 3.76, 4.5];
    partials.forEach((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = fundamental * ratio;

      const gain = ctx.createGain();
      const peak = 0.6 / (i + 1);
      const decay = 3.2 + i * 0.4;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(peak, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + decay + 0.2);
    });
  }

  /* ---------------- Haptic + visual tap feedback ---------------- */

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  function spawnRipple(x, y) {
    const r = document.createElement("div");
    r.className = "ripple";
    r.style.left = x + "px";
    r.style.top = y + "px";
    rippleLayer.appendChild(r);
    setTimeout(() => r.remove(), 750);
  }

  /* ---------------- Wake Lock ---------------- */

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (e) {
      /* ignore — not fatal */
    }
  }
  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (state.screen === "session" && document.visibilityState === "visible") {
      requestWakeLock();
    }
  });

  /* ---------------- Setup screen ---------------- */

  function refreshDurationUI() {
    durationValueEl.textContent = state.durationMin;
    [...presetsWrap.children].forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.min) === state.durationMin);
    });
    if (state.intervalMin >= state.durationMin) {
      state.intervalMin = Math.max(1, state.durationMin - 1 || 1);
      intervalValueEl.textContent = state.intervalMin;
    }
  }

  function refreshIntervalUI() {
    intervalValueEl.textContent = state.intervalMin;
  }

  el("btn-history").addEventListener("click", () => {
    renderHistory();
    showScreen("history");
  });

  document.querySelectorAll(".stepper-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "dur-inc") state.durationMin = Math.min(120, state.durationMin + 1);
      if (action === "dur-dec") state.durationMin = Math.max(1, state.durationMin - 1);
      if (action === "int-inc")
        state.intervalMin = Math.min(Math.max(1, state.durationMin - 1), state.intervalMin + 1);
      if (action === "int-dec") state.intervalMin = Math.max(1, state.intervalMin - 1);
      refreshDurationUI();
      refreshIntervalUI();
    });
  });

  presetsWrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".preset");
    if (!btn) return;
    state.durationMin = Number(btn.dataset.min);
    refreshDurationUI();
  });

  gongToggle.addEventListener("click", () => {
    state.gongEnabled = !state.gongEnabled;
    gongToggle.setAttribute("aria-checked", String(state.gongEnabled));
    intervalField.hidden = !state.gongEnabled;
  });

  el("btn-start").addEventListener("click", () => {
    getAudioCtx(); // unlock audio on user gesture
    startCountdown();
  });

  /* ---------------- Countdown ---------------- */

  function startCountdown() {
    let n = 15;
    countdownNumber.textContent = n;
    showScreen("countdown");
    const timer = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(timer);
        countdownNumber.textContent = "0";
        playGong(1);
        startSession();
      } else {
        countdownNumber.textContent = n;
      }
    }, 1000);
  }

  /* ---------------- Session ---------------- */

  let sessionTimer = null;
  let activePointers = new Map(); // pointerId -> {x,y,t,moved}
  let holdTimeout = null;
  let holdActive = false;

  function startSession() {
    session.startTime = Date.now();
    session.durationSec = state.durationMin * 60;
    session.gongEnabled = state.gongEnabled;
    session.intervalSec = state.intervalMin * 60;
    session.touches = [];
    session.nextGongAt = session.intervalSec;
    session.ended = false;

    sessionTotalEl.textContent = fmtTime(session.durationSec);
    sessionTimeEl.textContent = "00:00";
    sessionTouchesEl.textContent = "0";
    sessionInstructions.classList.remove("faded");

    requestWakeLock();
    showScreen("session");

    setTimeout(() => sessionInstructions.classList.add("faded"), 6000);

    sessionTimer = setInterval(sessionTick, 250);
  }

  function sessionTick() {
    if (session.ended) return;
    const elapsed = (Date.now() - session.startTime) / 1000;
    sessionTimeEl.textContent = fmtTime(elapsed);

    if (
      session.gongEnabled &&
      session.nextGongAt < session.durationSec - 5 &&
      elapsed >= session.nextGongAt
    ) {
      playGong(0.85);
      session.nextGongAt += session.intervalSec;
    }

    if (elapsed >= session.durationSec) {
      endSession("complete");
    }
  }

  function logReturn() {
    const elapsed = (Date.now() - session.startTime) / 1000;
    session.touches.push(Math.round(elapsed));
    sessionTouchesEl.textContent = session.touches.length;
    vibrate(40);
  }

  function endSession(reason) {
    if (session.ended) return;
    session.ended = true;
    clearInterval(sessionTimer);
    releaseWakeLock();
    resetHoldUI();

    if (reason === "complete") {
      playGong(1);
      setTimeout(() => finishToSummary(), 1600);
    } else {
      vibrate([30, 60, 30]);
      finishToSummary();
    }
  }

  function finishToSummary() {
    const actualDurationSec = Math.min(
      session.durationSec,
      Math.round((Date.now() - session.startTime) / 1000)
    );
    saveSessionToHistory(actualDurationSec);
    renderSummary(actualDurationSec);
    showScreen("summary");
  }

  /* --- pointer handling: tap = return; two-finger hold = end --- */

  function resetHoldUI() {
    holdActive = false;
    if (holdTimeout) {
      clearTimeout(holdTimeout);
      holdTimeout = null;
    }
    holdProgress.classList.remove("visible");
    holdProgressFill.style.transition = "none";
    holdProgressFill.style.width = "0%";
  }

  function startHold() {
    holdActive = true;
    holdProgress.classList.add("visible");
    holdProgressFill.style.transition = "none";
    holdProgressFill.style.width = "0%";
    // force reflow so the transition below actually animates
    void holdProgressFill.offsetWidth;
    holdProgressFill.style.transition = `width ${HOLD_MS}ms linear`;
    holdProgressFill.style.width = "100%";
    holdTimeout = setTimeout(() => {
      if (activePointers.size >= 2) {
        endSession("manual");
      } else {
        resetHoldUI();
      }
    }, HOLD_MS);
  }

  const sessionEl = screens.session;

  sessionEl.addEventListener("pointerdown", (e) => {
    if (state.screen !== "session" || session.ended) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, multi: false });

    if (activePointers.size >= 2) {
      activePointers.forEach((pt) => (pt.multi = true));
      if (!holdActive) startHold();
    }
  });

  sessionEl.addEventListener("pointermove", (e) => {
    const p = activePointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_MOVE) p.moved = true;
  });

  function releasePointer(e) {
    const p = activePointers.get(e.pointerId);
    if (!p) return;
    const wasSize = activePointers.size;
    activePointers.delete(e.pointerId);

    if (state.screen !== "session" || session.ended) return;

    if (wasSize >= 2) {
      // part of a multi-finger gesture; cancel the hold if fewer than 2 fingers remain
      if (activePointers.size < 2) resetHoldUI();
      return;
    }

    // solo tap: this pointer was never part of a multi-finger gesture
    const duration = Date.now() - p.t;
    if (!p.multi && !p.moved && duration <= TAP_MAX_MS) {
      logReturn();
      spawnRipple(e.clientX, e.clientY);
    }
  }

  sessionEl.addEventListener("pointerup", releasePointer);
  sessionEl.addEventListener("pointercancel", releasePointer);
  sessionEl.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "touch") releasePointer(e);
  });

  sessionEl.addEventListener(
    "touchmove",
    (e) => {
      if (state.screen === "session") e.preventDefault();
    },
    { passive: false }
  );
  sessionEl.addEventListener("contextmenu", (e) => e.preventDefault());

  /* ---------------- Summary ---------------- */

  function renderSummary(actualDurationSec) {
    summaryDuration.textContent = fmtTime(actualDurationSec);
    summaryTouches.textContent = session.touches.length;

    const stats = computeSessionStats(session.touches, actualDurationSec);
    summaryAvg.textContent = stats.avgGap === null ? "—" : fmtTime(stats.avgGap);

    summaryTimeline.innerHTML = "";
    session.touches.forEach((t) => {
      const mark = document.createElement("div");
      mark.className = "timeline-mark";
      const pct = Math.min(100, (t / actualDurationSec) * 100);
      mark.style.left = `calc(${pct}% - 1px)`;
      summaryTimeline.appendChild(mark);
    });
  }

  el("btn-new-session").addEventListener("click", () => showScreen("setup"));
  el("btn-view-history").addEventListener("click", () => {
    renderHistory();
    showScreen("history");
  });

  /* ---------------- History ---------------- */

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveSessionToHistory(actualDurationSec) {
    const history = loadHistory();
    history.unshift({
      date: new Date().toISOString(),
      durationSec: actualDurationSec,
      touchCount: session.touches.length,
      timestamps: session.touches,
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 200)));
  }

  function localDateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function getSessionDateSet(history) {
    const set = new Set();
    history.forEach((h) => set.add(localDateKey(new Date(h.date))));
    return set;
  }

  function calcStreak(dateSet) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    let cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    if (!dateSet.has(localDateKey(cursor))) {
      cursor = new Date(cursor.getTime() - DAY_MS);
    }
    let streak = 0;
    while (dateSet.has(localDateKey(cursor))) {
      streak++;
      cursor = new Date(cursor.getTime() - DAY_MS);
    }
    return streak;
  }

  /* --- calendar --- */

  let calendarViewDate = new Date();
  let historyDateSet = new Set();

  function renderCalendar() {
    const year = calendarViewDate.getFullYear();
    const month = calendarViewDate.getMonth();
    calMonthLabel.textContent = calendarViewDate.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

    const now = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
    calNextBtn.disabled = isCurrentMonth;

    const firstDay = new Date(year, month, 1);
    const startWeekday = firstDay.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayKey = localDateKey(now);

    let html = '<div class="cal-weekdays">';
    ["S", "M", "T", "W", "T", "F", "S"].forEach((d) => (html += `<div>${d}</div>`));
    html += '</div><div class="cal-days">';

    for (let i = 0; i < startWeekday; i++) html += '<div class="cal-day empty"></div>';

    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(year, month, day);
      const key = localDateKey(d);
      const classes = ["cal-day"];
      if (historyDateSet.has(key)) classes.push("has-session");
      if (key === todayKey) classes.push("today");
      html += `<div class="${classes.join(" ")}"><span>${day}</span>${
        historyDateSet.has(key) ? '<i class="dot"></i>' : ""
      }</div>`;
    }
    html += "</div>";
    calendarGrid.innerHTML = html;
  }

  calPrevBtn.addEventListener("click", () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
    renderCalendar();
  });
  calNextBtn.addEventListener("click", () => {
    if (calNextBtn.disabled) return;
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
    renderCalendar();
  });

  /* --- charts (hand-drawn SVG, no external deps) --- */

  function computeChartEntries(sessionsAsc) {
    return sessionsAsc.map((s) => {
      const stats = computeSessionStats(s.timestamps, s.durationSec);
      return {
        date: new Date(s.date),
        duration: s.durationSec,
        touches: s.touchCount,
        rpm: stats.rpm,
        avgGap: stats.avgGap ?? 0,
        maxGap: stats.maxGap,
      };
    });
  }

  function renderChart(container, entries, { type, valueFn, formatValue }) {
    if (!entries.length) {
      container.innerHTML = '<div class="chart-empty">Not enough data yet</div>';
      return;
    }

    const barW = 26,
      gap = 16,
      padL = 12,
      padR = 12,
      padTop = 22,
      padBottom = 26,
      height = 132;
    const chartH = height - padTop - padBottom;
    const n = entries.length;
    const width = padL + padR + n * (barW + gap) - gap;
    const values = entries.map(valueFn);
    const maxVal = Math.max(...values, 0.0001);

    let shapes = "";
    let valueLabels = "";
    let dateLabels = "";
    const pts = [];

    entries.forEach((e, i) => {
      const val = values[i];
      const x = padL + i * (barW + gap);
      const cx = x + barW / 2;
      const h = maxVal > 0 ? (val / maxVal) * chartH : 0;
      const y = padTop + (chartH - h);
      pts.push([cx, y]);

      if (type === "bar") {
        shapes += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${Math.max(
          h,
          2
        ).toFixed(1)}" rx="4" fill="var(--accent)"/>`;
      }

      valueLabels += `<text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(
        1
      )}" text-anchor="middle" font-size="9" fill="var(--text-dim)">${formatValue(val)}</text>`;

      const d = e.date;
      dateLabels += `<text x="${cx.toFixed(1)}" y="${height - 9}" text-anchor="middle" font-size="9" fill="var(--text-dim)">${
        d.getMonth() + 1
      }/${d.getDate()}</text>`;
    });

    if (type === "line") {
      const pathD = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
      shapes += `<path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
      pts.forEach(([x, y]) => {
        shapes += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="var(--accent)"/>`;
      });
    }

    const baseY = padTop + chartH;
    const baseline = `<line x1="0" y1="${baseY}" x2="${width}" y2="${baseY}" stroke="var(--border)" stroke-width="1"/>`;

    container.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${baseline}${shapes}${valueLabels}${dateLabels}</svg>`;
  }

  function renderCharts(history) {
    const chronological = [...history].reverse().slice(-CHART_LIMIT);
    const entries = computeChartEntries(chronological);

    renderChart(chartDuration, entries, { type: "bar", valueFn: (e) => e.duration, formatValue: (v) => fmtTime(v) });
    renderChart(chartReturns, entries, { type: "bar", valueFn: (e) => e.touches, formatValue: (v) => String(v) });
    renderChart(chartRpm, entries, { type: "line", valueFn: (e) => e.rpm, formatValue: (v) => v.toFixed(1) });
    renderChart(chartAvgGap, entries, { type: "line", valueFn: (e) => e.avgGap, formatValue: (v) => fmtTime(v) });
    renderChart(chartMaxGap, entries, { type: "bar", valueFn: (e) => e.maxGap, formatValue: (v) => fmtTime(v) });
  }

  /* --- session list + orchestration --- */

  function renderHistory() {
    const history = loadHistory();
    const hasHistory = history.length > 0;

    historyEmpty.hidden = hasHistory;
    historyScroll.hidden = !hasHistory;
    if (!hasHistory) return;

    historyDateSet = getSessionDateSet(history);
    streakValueEl.textContent = calcStreak(historyDateSet);

    calendarViewDate = new Date();
    renderCalendar();
    renderCharts(history);

    historyList.innerHTML = "";
    history.forEach((entry) => {
      const li = document.createElement("li");
      li.className = "history-item";
      const d = new Date(entry.date);
      const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      li.innerHTML = `
        <div>
          <div class="history-item-date">${dateStr}</div>
          <div class="history-item-sub">${timeStr} · ${fmtTime(entry.durationSec)}</div>
        </div>
        <div class="history-item-count">
          <div class="n">${entry.touchCount}</div>
          <div class="l">returns</div>
        </div>`;
      historyList.appendChild(li);
    });
  }

  el("btn-history-back").addEventListener("click", () => showScreen("setup"));
  el("btn-clear-history").addEventListener("click", () => {
    if (confirm("Clear all session history?")) {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
  });

  /* ---------------- Init ---------------- */

  refreshDurationUI();
  refreshIntervalUI();
  showScreen("setup");

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();

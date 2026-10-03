"use strict";

const SEEK_STEP = 2;
const NUDGE_STEP = 1;
const RATES = [0.25, 0.5, 1, 2];
const MIN_CLIP = 0.5;
const MAX_ZOOM = 200;

const state = {
  items: [],
  days: [],
  day: null,
  visible: [],
  current: -1,
  clips: [],
  active: -1,
  marker: null,
  looping: true,
  dragging: false,
  generation: 0,
  rate: 1,
  zoom: 1,
  offset: 0,
  history: [],
};

/** Snapshot the clips so ctrl+z can put them back. */
function remember() {
  state.history.push(JSON.stringify({ clips: state.clips, active: state.active }));
  if (state.history.length > 50) state.history.shift();
}

function undo() {
  const previous = state.history.pop();
  if (!previous) {
    toast("nothing to undo", true);
    return;
  }
  const restored = JSON.parse(previous);
  state.clips = restored.clips;
  state.active = restored.active;
  state.marker = null;
  nameBox.value = activeClip()?.name ?? "";
  drawTimeline();
  updateSaveButton();
  playActiveClip();
}

/** The stretch of the video the bar currently shows, in seconds. */
function view() {
  const span = player.duration || currentItem()?.duration || 0;
  const width = span / state.zoom;
  const start = Math.min(Math.max(state.offset, 0), Math.max(span - width, 0));
  return { span, start, width: width || 1 };
}

/** Where `time` sits across the bar, 0 at its left edge and 1 at its right. */
function acrossBar(time) {
  const window = view();
  return (time - window.start) / window.width;
}

/** The time at `fraction` of the way across the bar. */
function atFraction(fraction) {
  const window = view();
  return window.start + fraction * window.width;
}

function zoomBy(factor, anchor) {
  const span = view().span;
  if (!span) return;
  const held = atFraction(anchor);
  state.zoom = Math.min(Math.max(state.zoom * factor, 1), MAX_ZOOM);
  state.offset = held - (span / state.zoom) * anchor;
  drawTimeline();
}

function keepPlayheadInView() {
  if (state.zoom === 1) return;
  const window = view();
  const at = player.currentTime;
  if (at < window.start || at > window.start + window.width) {
    state.offset = at - window.width / 2;
    drawTimeline();
  }
}

const element = (id) => document.getElementById(id);
const player = element("player");
const photo = element("photo");
const nameBox = element("name");

function stamp(seconds) {
  if (seconds === null || Number.isNaN(seconds)) return "–";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}

function short(seconds) {
  if (seconds === null) return "–";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

function currentItem() {
  return state.visible[state.current] || null;
}

function activeClip() {
  return state.clips[state.active] || null;
}

function frame() {
  const item = currentItem();
  return item && item.fps ? 1 / item.fps : 0.04;
}

async function getJSON(url, options) {
  const answer = await fetch(url, options);
  return { ok: answer.ok, body: await answer.json() };
}

function toast(message, bad) {
  const box = element("toast");
  box.textContent = message;
  box.hidden = false;
  if (bad) box.dataset.bad = "1"; else delete box.dataset.bad;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 3200);
}

function notice(message) {
  element("notice").hidden = !message;
  element("notice-text").textContent = message || "";
}

async function load() {
  const { body } = await getJSON("/api/library");
  state.items = body.items;
  state.days = body.days;
  state.day = state.days[0] || null;
  applyFilter(0);
}

function renderDays() {
  const nav = element("days");
  nav.replaceChildren();
  for (const day of state.days) {
    const button = document.createElement("button");
    button.textContent = day;
    button.setAttribute("aria-current", String(day === state.day));
    button.onclick = () => { state.day = day; applyFilter(0); };
    nav.append(button);
  }
}

function applyFilter(startAt) {
  const hideSaved = element("hide-saved").checked;
  state.visible = state.items.filter((item) =>
    item.day === state.day && !(hideSaved && item.saves.length));
  renderDays();
  renderStrip();
  const clips = state.visible.reduce((total, item) => total + item.saves.length, 0);
  element("count").textContent = `${state.visible.length} files · ${clips} keepers`;
  select(Math.min(startAt, state.visible.length - 1));
}

function renderStrip() {
  const strip = element("filmstrip");
  strip.replaceChildren();
  state.visible.forEach((item, index) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.index = String(index);
    const thumb = document.createElement("img");
    thumb.loading = "lazy";
    thumb.src = `/api/thumb?f=${encodeURIComponent(item.relpath)}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const clock = item.captured.slice(11, 16);
    const length = item.kind === "video" ? `${item.duration.toFixed(0)}s` : "photo";
    meta.innerHTML =
      `<span class="name">${item.label}</span>` +
      `<span class="sub">${clock} · ${length}</span>`;
    if (item.saves.length) {
      const kept = document.createElement("span");
      kept.className = "kept";
      const count = item.saves.length;
      kept.textContent = `✓ ${count} clip${count > 1 ? "s" : ""}: ` +
        item.saves.map((save) => save.name).join(", ");
      meta.append(kept);
    }
    tile.append(thumb, meta);
    tile.onclick = () => select(index);
    strip.append(tile);
  });
  highlightTile();
}

function highlightTile() {
  for (const tile of document.querySelectorAll(".tile")) {
    const active = Number(tile.dataset.index) === state.current;
    tile.setAttribute("aria-current", String(active));
    if (active) tile.scrollIntoView({ block: "nearest" });
  }
}

function select(index) {
  state.generation += 1;
  if (!state.visible.length) {
    state.current = -1;
    player.removeAttribute("data-live");
    photo.removeAttribute("data-live");
    element("title").textContent = "nothing to show";
    element("timeline").hidden = true;
    return;
  }
  state.current = Math.max(0, Math.min(index, state.visible.length - 1));
  const item = currentItem();
  state.zoom = 1;
  state.offset = 0;
  state.history = [];
  state.clips = item.saves.map((save) => ({
    start: save.start ?? null, end: save.end ?? null, name: save.name, saved: true,
  }));
  state.active = -1;
  state.marker = null;
  nameBox.value = "";
  element("title").textContent = `${item.label} · ${item.day}`;
  highlightTile();
  if (item.kind === "video") {
    addClip();
    showVideo(item, state.generation);
  } else {
    showPhoto(item);
  }
  updateSaveButton();
}

function showPhoto(item) {
  player.pause();
  player.removeAttribute("src");
  player.removeAttribute("data-live");
  element("timeline").hidden = true;
  notice("");
  photo.src = `/api/photo?f=${encodeURIComponent(item.relpath)}`;
  photo.dataset.live = "1";
}

async function showVideo(item, token) {
  photo.removeAttribute("data-live");
  photo.removeAttribute("src");
  element("timeline").hidden = false;
  player.removeAttribute("data-live");
  player.poster = `/api/thumb?f=${encodeURIComponent(item.relpath)}`;
  notice("preparing a playable proxy…");
  const outcome = await waitForProxy(item.relpath, token);
  if (state.generation !== token) return;
  if (outcome.state !== "ready") {
    notice(outcome.error || `ffmpeg could not prepare ${item.label}`);
    return;
  }
  notice("");
  player.src = `/api/video?f=${encodeURIComponent(item.relpath)}`;
  player.dataset.live = "1";
  player.playbackRate = state.rate;
  player.play().catch(() => notice("press space to play"));
  prefetchNeighbours();
}

async function waitForProxy(relpath, token) {
  const url = `/api/prepare?f=${encodeURIComponent(relpath)}`;
  let { body } = await getJSON(url);
  while ((body.state === "queued" || body.state === "working")
         && state.generation === token) {
    await new Promise((done) => setTimeout(done, 600));
    ({ body } = await getJSON(url));
  }
  return body;
}

function prefetchNeighbours() {
  state.visible.slice(state.current + 1, state.current + 4)
    .filter((item) => item.kind === "video")
    .forEach((item) => {
      fetch(`/api/prepare?f=${encodeURIComponent(item.relpath)}&urgent=0`)
        .catch(() => undefined);
    });
}

function wholeVideo() {
  const span = player.duration || currentItem()?.duration || 0;
  return { start: 0, end: span || null, name: "", saved: false, untouched: true };
}

function addClip() {
  remember();
  const span = player.duration || currentItem()?.duration || 0;
  const ends = state.clips.map((clip) => clip.end ?? clip.start ?? 0);
  const lastEnd = ends.length ? Math.max(...ends) : 0;
  if (!state.clips.length || !span) {
    state.clips.push(wholeVideo());
    state.active = state.clips.length - 1;
  } else if (span - lastEnd >= MIN_CLIP) {
    state.clips.push({ start: lastEnd, end: span, name: "", saved: false });
    state.active = state.clips.length - 1;
  } else if (!splitLastClip()) {
    return;
  }
  state.marker = null;
  nameBox.value = activeClip().name;
  drawTimeline();
  updateSaveButton();
  playActiveClip();
}

function playActiveClip() {
  const clip = activeClip();
  if (!clip || clip.start === null || !player.duration) return;
  player.currentTime = clip.start;
  player.play().catch(() => undefined);
}

function splitLastClip() {
  const index = state.clips.reduce((found, clip, at) =>
    !clip.saved && (clip.end ?? 0) - (clip.start ?? 0) >= MIN_CLIP * 2 ? at : found, -1);
  if (index < 0) {
    toast("no room for another clip — drag a handle in first", true);
    return false;
  }
  const clip = state.clips[index];
  const middle = (clip.start + clip.end) / 2;
  state.clips.splice(index + 1, 0,
                     { start: middle, end: clip.end, name: "", saved: false });
  clip.end = middle;
  clip.untouched = false;
  state.active = index + 1;
  return true;
}

function selectClip(index) {
  state.active = index;
  state.marker = null;
  nameBox.value = state.clips[index].name;
  drawTimeline();
  updateSaveButton();
  playActiveClip();
}

function drawTimeline() {
  const window = view();
  const span = window.span;
  const bands = element("bands");
  bands.replaceChildren();
  state.clips.forEach((clip, index) => {
    if (clip.start === null || !span) return;
    const end = clip.end === null ? clip.start : clip.end;
    const band = document.createElement("div");
    band.className = "band";
    band.style.left = `${acrossBar(clip.start) * 100}%`;
    band.style.width = `${Math.max(((end - clip.start) / window.width) * 100, 0.4)}%`;
    if (clip.saved) band.dataset.saved = "1";
    if (index === state.active) band.dataset.active = "1";
    if (clip.name) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = clip.name;
      band.append(tag);
    }
    bands.append(band);
  });
  const clip = activeClip();
  if (clip && !clip.saved && span) {
    for (const edge of ["start", "end"]) {
      if (clip[edge] === null) continue;
      const handle = document.createElement("div");
      handle.className = "handle";
      handle.style.left = `${acrossBar(clip[edge]) * 100}%`;
      handle.dataset.edge = edge;
      handle.dataset.label = edge === "start" ? "IN" : "OUT";
      if (state.marker === edge) handle.dataset.selected = "1";
      handle.onpointerdown = (event) => startDrag(event, edge);
      bands.append(handle);
    }
  }
  renderChips();
  element("loop-button").setAttribute("aria-pressed", String(state.looping));
  const summary = clip && clip.start !== null
    ? (clip.end !== null
        ? `in ${stamp(clip.start)} → out ${stamp(clip.end)} · ` +
          `${(clip.end - clip.start).toFixed(1)}s`
        : `in ${stamp(clip.start)}`)
    : "";
  element("selected").textContent =
    summary + (state.marker ? `  ·  ${state.marker === "start" ? "IN" : "OUT"} selected` : "");
  const zoomed = state.zoom > 1 ? `  ·  zoom ${state.zoom.toFixed(1)}×` : "";
  element("hint").textContent = (clip && !clip.saved
    ? (clip.untouched ? "drag the IN and OUT handles, or press i / o at the playhead"
                      : (state.marker ? "arrows move it 1 s · shift+arrows one frame"
                                      : "click a handle to nudge it with the arrows"))
    : "") + zoomed;
}

function renderChips() {
  const row = element("clips");
  row.replaceChildren();
  state.clips.forEach((clip, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.setAttribute("aria-current", String(index === state.active));
    if (clip.saved) chip.dataset.saved = "1";
    const range = clip.start === null ? "new clip"
      : `${short(clip.start)}–${clip.end === null ? "?" : short(clip.end)}`;
    chip.textContent = `${index + 1}. ${clip.name || range}${clip.saved ? " ✓" : ""}`;
    chip.onclick = () => { chip.blur(); selectClip(index); };
    row.append(chip);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "chip add";
  add.textContent = "+ clip (a)";
  add.onclick = () => { add.blur(); addClip(); };
  row.append(add);
}

function editable() {
  const clip = activeClip();
  if (!clip) return null;
  if (clip.saved) {
    toast("that clip is already saved — press a for a new one", true);
    return null;
  }
  return clip;
}

function markIn() {
  remember();
  const clip = editable();
  if (!clip || !player.duration) return;
  clip.start = player.currentTime;
  clip.untouched = false;
  if (clip.end !== null && clip.end <= clip.start) clip.end = null;
  state.marker = "start";
  drawTimeline();
  updateSaveButton();
}

function markOut() {
  remember();
  const clip = editable();
  if (!clip || !player.duration) return;
  if (clip.start === null) { toast("mark the in point first (i)", true); return; }
  if (player.currentTime <= clip.start) {
    toast("the out point must come after the in point", true);
    return;
  }
  clip.end = player.currentTime;
  clip.untouched = false;
  state.marker = "end";
  drawTimeline();
  updateSaveButton();
}

function clearMarks() {
  remember();
  const clip = editable();
  if (!clip) return;
  Object.assign(clip, wholeVideo(), { name: clip.name });
  state.marker = null;
  state.looping = false;
  element("loop-button").setAttribute("aria-pressed", "false");
  drawTimeline();
  updateSaveButton();
}

function moveMarker(delta) {
  remember();
  const clip = editable();
  if (!clip || !state.marker || clip[state.marker] === null) return;
  const span = player.duration || 0;
  const other = state.marker === "start" ? clip.end : clip.start;
  let moved = clip[state.marker] + delta;
  moved = Math.min(Math.max(moved, 0), span);
  if (other !== null) {
    moved = state.marker === "start"
      ? Math.min(moved, other - frame())
      : Math.max(moved, clip.start + frame());
  }
  clip[state.marker] = moved;
  clip.untouched = false;
  player.currentTime = moved;
  drawTimeline();
}

function startDrag(event, edge) {
  event.preventDefault();
  event.stopPropagation();
  const clip = editable();
  if (!clip) return;
  remember();
  state.marker = edge;
  state.dragging = true;
  const move = (moved) => {
    let at = atFraction(barFraction(moved));
    const other = edge === "start" ? clip.end : clip.start;
    if (other !== null) {
      at = edge === "start" ? Math.min(at, other - frame())
                            : Math.max(at, other + frame());
    }
    clip[edge] = at;
    clip.untouched = false;
    player.currentTime = at;
    drawTimeline();
  };
  const release = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", release);
    state.dragging = false;
    updateSaveButton();
    playActiveClip();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", release);
  move(event);
}

function saveable() {
  const item = currentItem();
  if (!item || !nameBox.value.trim()) return false;
  if (item.kind === "photo") return !item.saves.length;
  const clip = activeClip();
  return Boolean(clip && !clip.saved && clip.start !== null && clip.end !== null);
}

function updateSaveButton() {
  element("save-button").disabled = !saveable();
  const clip = activeClip();
  if (clip && !clip.saved) clip.name = nameBox.value.trim();
}

async function save(event) {
  event.preventDefault();
  if (!saveable()) return;
  const item = currentItem();
  const clip = activeClip();
  const payload = { relpath: item.relpath, name: nameBox.value.trim() };
  if (item.kind === "video") {
    payload.start = clip.start;
    payload.end = clip.end;
  }
  element("save-button").disabled = true;
  const { ok, body } = await getJSON("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!ok) {
    toast(body.error || "save failed", true);
    updateSaveButton();
    return;
  }
  item.saves.push({ name: body.name, start: payload.start, end: payload.end });
  toast(`saved ${body.saved}`);
  renderStrip();
  if (item.kind === "photo") {
    step(1);
    return;
  }
  clip.saved = true;
  clip.name = body.name;
  nameBox.value = "";
  addClip();
}

function step(delta) {
  select(state.current + delta);
}

function seek(delta) {
  if (!player.duration) return;
  player.currentTime = Math.min(Math.max(player.currentTime + delta, 0),
                                player.duration);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else element("screen").requestFullscreen().catch(() =>
    toast("fullscreen refused", true));
}

function toggleLoop() {
  state.looping = !state.looping;
  element("loop-button").setAttribute("aria-pressed", String(state.looping));
  if (state.looping) playActiveClip();
}

function onKey(event) {
  if (event.target.matches("input, textarea")) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const item = currentItem();
  const video = item && item.kind === "video";
  const sideways = (delta) => {
    if (video && state.marker) moveMarker(event.shiftKey ? delta * frame()
                                                         : delta * NUDGE_STEP);
    else if (video) seek(delta * SEEK_STEP);
    else step(delta);
  };
  const actions = {
    j: () => step(1),
    k: () => step(-1),
    "]": () => step(1),
    "[": () => step(-1),
    ArrowRight: () => sideways(1),
    ArrowLeft: () => sideways(-1),
    ArrowDown: () => step(1),
    ArrowUp: () => step(-1),
    " ": () => { if (video) player.paused ? player.play() : player.pause(); },
    ",": () => { player.pause(); seek(-frame()); },
    ".": () => { player.pause(); seek(frame()); },
    i: markIn,
    o: markOut,
    a: () => { if (video) addClip(); },
    x: clearMarks,
    l: toggleLoop,
    f: toggleFullscreen,
    n: () => nameBox.focus(),
    Escape: () => { state.marker = null; drawTimeline(); },
    1: () => setRate(RATES[0]),
    2: () => setRate(RATES[1]),
    3: () => setRate(RATES[2]),
    4: () => setRate(RATES[3]),
    "?": () => element("help").showModal(),
  };
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

function onEnded() {
  if (state.looping) playActiveClip();
  else step(1);
}

function onTimeUpdate() {
  const span = player.duration || 0;
  element("clock").textContent = stamp(player.currentTime);
  element("played").style.left = span ? `${acrossBar(player.currentTime) * 100}%` : "0";
  keepPlayheadInView();
  const clip = activeClip();
  if (state.looping && !state.dragging && clip && clip.end !== null
      && player.currentTime >= clip.end) {
    player.currentTime = clip.start;
  }
}

function barFraction(event) {
  const box = element("track").getBoundingClientRect();
  return Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
}

function scrub(event) {
  if (player.duration) player.currentTime = atFraction(barFraction(event));
}

function setRate(rate) {
  state.rate = rate;
  player.playbackRate = rate;
  renderRates();
}

function renderRates() {
  const row = element("rates");
  row.replaceChildren();
  for (const rate of RATES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${rate}×`;
    button.setAttribute("aria-pressed", String(rate === state.rate));
    button.onclick = () => { button.blur(); setRate(rate); };
    row.append(button);
  }
}

function press(id, action) {
  element(id).onclick = (event) => {
    event.currentTarget.blur();
    action();
  };
}

function wire() {
  element("save-bar").onsubmit = save;
  nameBox.oninput = updateSaveButton;
  element("hide-saved").onchange = () => applyFilter(state.current);
  element("help-button").onclick = () => element("help").showModal();
  press("in-button", markIn);
  press("out-button", markOut);
  press("clear-button", clearMarks);
  press("loop-button", toggleLoop);
  press("fullscreen-button", toggleFullscreen);
  element("screen").ondblclick = toggleFullscreen;
  element("track").addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.25 : 1 / 1.25, barFraction(event));
  }, { passive: false });
  element("track").onpointerdown = (event) => {
    if (event.target.classList.contains("handle")) return;
    state.marker = null;
    scrub(event);
    const move = (moved) => scrub(moved);
    const release = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    drawTimeline();
  };
  player.ontimeupdate = onTimeUpdate;
  player.onloadedmetadata = () => {
    player.playbackRate = state.rate;
    for (const clip of state.clips) {
      if (clip.untouched && clip.end === null) clip.end = player.duration;
    }
    drawTimeline();
  };
  player.onended = onEnded;
  document.addEventListener("keydown", onKey);
  renderRates();
}

wire();
load();

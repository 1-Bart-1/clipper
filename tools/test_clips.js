"use strict";
// Exercises the viewer's clip arithmetic against a stubbed DOM, because the
// behaviour of `a`, the loop and the zoom cannot be eyeballed from a diff.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function stub() {
  const node = {
    style: {}, dataset: {}, children: [], checked: false, value: "",
    textContent: "", duration: 0, currentTime: 0, paused: false, playbackRate: 1,
    classList: { contains: () => false, add() {}, remove() {} },
    replaceChildren() { this.children = []; },
    append(...kids) { this.children.push(...kids); },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    toggleAttribute() {},
    removeEventListener() {}, focus() {}, blur() {}, scrollIntoView() {},
    showModal() {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    matches: () => false, closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
  };
  return node;
}

const nodes = new Map();
const context = {
  console,
  setTimeout, clearTimeout,
  fetch: () => Promise.resolve({ ok: true, json: () => ({ items: [], days: [] }) }),
  document: {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, stub());
      return nodes.get(id);
    },
    createElement: stub,
    querySelectorAll: () => [],
    addEventListener() {},
    fullscreenElement: null,
  },
  window: { addEventListener() {}, removeEventListener() {} },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(
  path.join(__dirname, "..", "clipper", "static", "app.js"), "utf8"), context);

let failures = 0;
function check(what, got, wanted) {
  const same = JSON.stringify(got) === JSON.stringify(wanted);
  if (!same) {
    failures += 1;
    console.log(`  FAIL ${what}\n       got    ${JSON.stringify(got)}` +
                `\n       wanted ${JSON.stringify(wanted)}`);
  } else {
    console.log(`  ok   ${what}`);
  }
}

function setUp(clips, duration = 60) {
  vm.runInContext(`
    state.visible = [{relpath: "a.MOV", label: "a.MOV", kind: "video", day: "01-10",
                      captured: "2026-10-01T12:00:00", duration: ${duration},
                      fps: 25, size: 1, saves: []}];
    state.current = 0;
    state.clips = ${JSON.stringify(clips)};
    state.active = ${clips.length ? 0 : -1};
    state.zoom = 1; state.offset = 0; state.dragging = false;
    player.duration = ${duration};
  `, context);
}

const ranges = () => vm.runInContext(
  "state.clips.map(c => [c.start, c.end])", context);

console.log("add clip");
setUp([]);
vm.runInContext("addClip()", context);
check("empty video gets one clip spanning the whole thing", ranges(), [[0, 60]]);

setUp([{ start: 0, end: 60, name: "", saved: false, untouched: true }]);
vm.runInContext("addClip()", context);
check("whole video splits into halves", ranges(), [[0, 30], [30, 60]]);
check("the new half is active", vm.runInContext("state.active", context), 1);

setUp([{ start: 0, end: 10, name: "", saved: false, untouched: false }]);
vm.runInContext("addClip()", context);
check("a trimmed first clip is left alone", ranges(), [[0, 10], [10, 60]]);
check("the new clip is active", vm.runInContext("state.active", context), 1);

setUp([{ start: 0, end: 10, name: "one", saved: true },
       { start: 10, end: 25, name: "", saved: false, untouched: false }]);
vm.runInContext("addClip()", context);
check("the gap after the last clip is taken", ranges(), [[0, 10], [10, 25], [25, 60]]);

setUp([{ start: 0, end: 60, name: "all", saved: true }]);
vm.runInContext("addClip()", context);
check("a saved clip covering everything is never cut up", ranges(), [[0, 60]]);

console.log("loop");
setUp([{ start: 5, end: 10, name: "", saved: false }]);
vm.runInContext("player.currentTime = 10.5; onTimeUpdate()", context);
check("playing past the out point returns to the in point",
      vm.runInContext("player.currentTime", context), 5);
vm.runInContext("state.dragging = true; player.currentTime = 10.5; onTimeUpdate()",
                context);
check("dragging a handle does not trigger the loop",
      vm.runInContext("player.currentTime", context), 10.5);
check("looping is on by default", vm.runInContext("state.looping", context), true);

console.log("zoom");
setUp([]);
vm.runInContext("zoomBy(2, 0.5)", context);
check("zooming halves the window", vm.runInContext("view().width", context), 30);
check("the anchored time stays put",
      Math.round(vm.runInContext("atFraction(0.5)", context) * 1000) / 1000, 30);
check("the window is centred on the anchor",
      vm.runInContext("view().start", context), 15);
vm.runInContext("zoomBy(0.001, 0.5)", context);
check("zooming out stops at the whole video",
      [vm.runInContext("state.zoom", context), vm.runInContext("view().start", context)],
      [1, 0]);
vm.runInContext("state.zoom = 4; state.offset = 0; player.currentTime = 50; onTimeUpdate()",
                context);
check("the playhead is followed when it leaves the window",
      vm.runInContext("view().start", context), 42.5);

console.log("a fresh clip spans the file, not whatever was loaded before");
setUp([], 20);
vm.runInContext("player.duration = 90", context);  // the previous, longer file
vm.runInContext("addClip()", context);
check("the new clip uses this file's length", ranges(), [[0, 20]]);
vm.runInContext(`
  state.clips = [{start: 0, end: 90, name: "", saved: false, untouched: true}];
  state.active = 0;
  onMetadata();
`, context);
check("loading the file corrects an untouched clip", ranges(), [[0, 20]]);
vm.runInContext(`
  state.clips = [{start: 1, end: 5, name: "", saved: false, untouched: false}];
  state.active = 0;
  onMetadata();
`, context);
check("loading the file leaves a trimmed clip alone", ranges(), [[1, 5]]);

console.log("picking a clip off the bar");
setUp([{ start: 0, end: 10, name: "one", saved: false, untouched: false },
       { start: 20, end: 30, name: "two", saved: false, untouched: false }]);
vm.runInContext("selectClip(1)", context);
check("the clicked clip becomes active", vm.runInContext("state.active", context), 1);
check("playback jumps to its in point",
      vm.runInContext("player.currentTime", context), 20);
vm.runInContext("player.currentTime = 30.5; onTimeUpdate()", context);
check("it loops that clip and not the other one",
      vm.runInContext("player.currentTime", context), 20);
vm.runInContext("state.marker = 'end'; moveMarker(1)", context);
check("its handle moves, the other clip's does not", ranges(), [[0, 10], [20, 31]]);
vm.runInContext("selectClip(0); state.marker = 'start'; moveMarker(2)", context);
check("and the same holds once the first clip is picked up",
      ranges(), [[2, 10], [20, 31]]);

console.log("deleting a clip");
setUp([{ start: 0, end: 10, name: "one", saved: false, untouched: false },
       { start: 20, end: 30, name: "two", saved: false, untouched: false }]);
vm.runInContext("selectClip(1); deleteClip()", context);
check("the selected clip goes", ranges(), [[0, 10]]);
check("the clip before it takes over", vm.runInContext("state.active", context), 0);
vm.runInContext("deleteClip()", context);
check("the last clip is never dropped", ranges(), [[0, 10]]);
vm.runInContext("undo()", context);
check("ctrl+z brings a deleted clip back", ranges(), [[0, 10], [20, 30]]);
setUp([{ start: 0, end: 10, name: "kept", saved: true },
       { start: 20, end: 30, name: "", saved: false, untouched: false }]);
vm.runInContext("selectClip(0); deleteClip()", context);
check("a saved clip is not dropped from the bar", ranges(), [[0, 10], [20, 30]]);

console.log("arrow keys");
function arrow(key, held = {}) {
  vm.runInContext(`onKey({key: "${key}", shiftKey: ${Boolean(held.shift)},
                          ctrlKey: ${Boolean(held.ctrl)}, altKey: false,
                          metaKey: false, preventDefault() {},
                          target: {matches: () => false}})`, context);
}
setUp([{ start: 0, end: 60, name: "", saved: false, untouched: true }]);
vm.runInContext("state.marker = null; player.currentTime = 10; player.paused = false",
                context);
arrow("ArrowRight");
check("a bare arrow seeks two seconds",
      vm.runInContext("player.currentTime", context), 12);
arrow("ArrowRight", { shift: true });
check("shift steps the playhead one frame at 25 fps",
      vm.runInContext("player.currentTime", context), 12.04);
check("and pauses to do it", vm.runInContext("player.paused", context), true);
vm.runInContext("state.marker = 'end'", context);
arrow("ArrowLeft");
check("with a marker selected a bare arrow moves it a second", ranges(), [[0, 59]]);
arrow("ArrowLeft", { shift: true });
check("and shift moves it one frame", ranges(), [[0, 58.96]]);

console.log("speed");
setUp([{ start: 0, end: 60, name: "", saved: false, untouched: true }]);
vm.runInContext("state.marker = null; setRate(1); player.currentTime = 10", context);
arrow("ArrowRight", { ctrl: true });
check("ctrl and right speeds up", vm.runInContext("state.rate", context), 2);
arrow("ArrowRight", { ctrl: true });
check("the fastest speed is the end of it", vm.runInContext("state.rate", context), 2);
arrow("ArrowLeft", { ctrl: true });
arrow("ArrowLeft", { ctrl: true });
arrow("ArrowLeft", { ctrl: true });
check("ctrl and left walks down to slomo",
      vm.runInContext("state.rate", context), 0.25);
arrow("ArrowLeft", { ctrl: true });
check("and stops there", vm.runInContext("state.rate", context), 0.25);
check("the player follows", vm.runInContext("player.playbackRate", context), 0.25);
check("changing speed never moves the playhead",
      vm.runInContext("player.currentTime", context), 10);

console.log("undo");
setUp([{ start: 0, end: 60, name: "", saved: false, untouched: true }]);
vm.runInContext("state.history = []; addClip(); markIn()", context);
check("two edits leave two snapshots",
      vm.runInContext("state.history.length", context), 2);
vm.runInContext("undo(); undo()", context);
check("undo walks back to the whole video", ranges(), [[0, 60]]);
check("undoing past the start is refused",
      vm.runInContext("undo(); state.clips.length", context), 1);

console.log("loop at the end of the file");
setUp([{ start: 2, end: 60, name: "", saved: false }]);
vm.runInContext("player.currentTime = 60; state.looping = true; onEnded()", context);
check("a clip ending with the video restarts at its in point",
      vm.runInContext("player.currentTime", context), 2);

console.log("picture zoom");
setUp([]);
vm.runInContext("resetMediaZoom(); zoomMedia(2, 500, 250)", context);
check("the point under the cursor stays under the cursor",
      vm.runInContext("[state.media.scale, state.media.x, state.media.y]", context),
      [2, -500, -250]);
vm.runInContext("panMedia(30, -10)", context);
check("panning shifts the picture",
      vm.runInContext("[state.media.x, state.media.y]", context), [-470, -260]);
vm.runInContext("zoomMedia(0.01, 500, 250)", context);
check("zooming back out recentres and stops at 1×",
      vm.runInContext("[state.media.scale, state.media.x, state.media.y]", context),
      [1, 0, 0]);
vm.runInContext("zoomMedia(100, 0, 0); zoomMedia(100, 0, 0)", context);
check("zoom is capped", vm.runInContext("state.media.scale", context), 20);

process.exit(failures ? 1 : 0);

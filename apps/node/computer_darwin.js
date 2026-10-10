// JXA driver behind talon-node's `computer` command on macOS. Run as
//   osascript -l JavaScript -e <this file> '<request json>'
// and answers one JSON object on stdout. Everything here ships with macOS:
// CoreGraphics events for the pointer, System Events for the keyboard and
// the accessibility tree. No helper binary, no cgo.
//
// Coordinates: callers never see screen points. The primary display is
// mapped onto a fixed "space" whose longest edge is at most `maxEdge`
// (default 1280), and the screenshot is rendered at exactly that size, so a
// pixel in the image, a position in the accessibility snapshot and a click
// target are all the same pair of numbers.

ObjC.import("CoreGraphics");
ObjC.import("AppKit");
ObjC.import("ApplicationServices");

var FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 };
var MOD_ALIASES = {
  shift: "shift",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
};
var SE_MOD = {
  shift: "shift down",
  ctrl: "control down",
  alt: "option down",
  cmd: "command down",
};
var KEYCODES = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

// Roles worth showing even when they carry no label of their own.
var INTERACTIVE = {
  AXButton: 1,
  AXTextField: 1,
  AXTextArea: 1,
  AXCheckBox: 1,
  AXRadioButton: 1,
  AXPopUpButton: 1,
  AXMenuButton: 1,
  AXComboBox: 1,
  AXSlider: 1,
  AXLink: 1,
  AXMenuItem: 1,
  AXMenuBarItem: 1,
  AXTab: 1,
  AXDisclosureTriangle: 1,
  AXIncrementor: 1,
  AXColorWell: 1,
  AXSearchField: 1,
  AXSecureTextField: 1,
  AXSwitch: 1,
  AXToggle: 1,
};

function run(argv) {
  var req = {};
  try {
    req = JSON.parse(argv[0] || "{}");
  } catch (e) {
    return JSON.stringify({ ok: false, error: "bad request json" });
  }
  try {
    var geo = geometry(req.maxEdge);
    var out = handle(req, geo) || {};
    out.ok = true;
    out.space = [geo.w, geo.h];
    out.cursor = cursor(geo);
    out.trusted = !!$.AXIsProcessTrusted();
    return JSON.stringify(out);
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: String((e && e.message) || e),
      trusted: !!$.AXIsProcessTrusted(),
    });
  }
}

// The primary display (origin 0,0 in CoreGraphics' global space — the one
// `screencapture -m` captures) and the factor between it and the space.
function geometry(maxEdge) {
  var edge = Math.max(320, Math.min(4096, Math.round(Number(maxEdge) || 1280)));
  var frame = $.NSScreen.screens.objectAtIndex(0).frame;
  var sw = frame.size.width;
  var sh = frame.size.height;
  var f = Math.max(sw, sh) > edge ? Math.max(sw, sh) / edge : 1;
  return { sw: sw, sh: sh, f: f, w: Math.round(sw / f), h: Math.round(sh / f) };
}

function cursor(geo) {
  var loc = $.CGEventGetLocation($.CGEventCreate($()));
  return [Math.round(loc.x / geo.f), Math.round(loc.y / geo.f)];
}

function point(req, geo, xKey, yKey) {
  var x = Number(req[xKey]);
  var y = Number(req[yKey]);
  if (!isFinite(x) || !isFinite(y)) {
    throw new Error("action needs numeric " + xKey + " and " + yKey);
  }
  if (x < 0 || y < 0 || x > geo.w || y > geo.h) {
    throw new Error(
      "(" + x + "," + y + ") is outside the " + geo.w + "x" + geo.h + " space",
    );
  }
  return $.CGPointMake(x * geo.f, y * geo.f);
}

function modifiers(list) {
  var out = [];
  (list || []).forEach(function (raw) {
    var m = MOD_ALIASES[String(raw).toLowerCase().trim()];
    if (!m) throw new Error('unknown modifier "' + raw + '"');
    if (out.indexOf(m) < 0) out.push(m);
  });
  return out;
}

function flagMask(mods) {
  var mask = 0;
  mods.forEach(function (m) {
    mask |= FLAG[m];
  });
  return mask;
}

function mouse(type, pt, button, clickState, mask) {
  var e = $.CGEventCreateMouseEvent($(), type, pt, button);
  if (clickState) $.CGEventSetIntegerValueField(e, 1, clickState);
  if (mask) $.CGEventSetFlags(e, mask);
  $.CGEventPost(0, e);
}

function handle(req, geo) {
  switch (req.action) {
    case "info":
      return {};
    case "move":
      mouse(5, point(req, geo, "x", "y"), 0, 0, 0);
      delay(0.03);
      return {};
    case "click":
      return click(req, geo);
    case "drag":
      return drag(req, geo);
    case "scroll":
      return scroll(req, geo);
    case "type":
      return typeText(req);
    case "key":
      return pressKey(req);
    case "snapshot":
      return snapshot(req, geo);
    default:
      throw new Error('unknown action "' + req.action + '"');
  }
}

function click(req, geo) {
  var pt = point(req, geo, "x", "y");
  var button = String(req.button || "left").toLowerCase();
  var spec = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] }[button];
  if (!spec) throw new Error('unknown button "' + req.button + '"');
  var count = Math.max(1, Math.min(3, Math.round(Number(req.count) || 1)));
  var mask = flagMask(modifiers(req.modifiers));
  mouse(5, pt, 0, 0, 0);
  delay(0.04);
  for (var i = 1; i <= count; i++) {
    mouse(spec[0], pt, spec[2], i, mask);
    delay(0.02);
    mouse(spec[1], pt, spec[2], i, mask);
    delay(0.06);
  }
  return {};
}

function drag(req, geo) {
  var from = point(req, geo, "x", "y");
  var to = point(req, geo, "toX", "toY");
  mouse(5, from, 0, 0, 0);
  delay(0.05);
  mouse(1, from, 0, 1, 0);
  delay(0.08);
  var steps = 12;
  for (var i = 1; i <= steps; i++) {
    var pt = $.CGPointMake(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
    mouse(6, pt, 0, 1, 0);
    delay(0.015);
  }
  delay(0.05);
  mouse(2, to, 0, 1, 0);
  return {};
}

// dy > 0 scrolls the content down (towards the end of the document), the
// way a person would describe it; CoreGraphics counts the other way.
function scroll(req, geo) {
  if (req.x !== undefined || req.y !== undefined) {
    mouse(5, point(req, geo, "x", "y"), 0, 0, 0);
    delay(0.04);
  }
  var dy = Math.max(-50, Math.min(50, Math.round(Number(req.dy) || 0)));
  var dx = Math.max(-50, Math.min(50, Math.round(Number(req.dx) || 0)));
  if (!dy && !dx) throw new Error("scroll needs a non-zero dy or dx");
  var e = $.CGEventCreateScrollWheelEvent2($(), 1, 2, -dy, -dx, 0);
  $.CGEventPost(0, e);
  delay(0.05);
  return {};
}

function typeText(req) {
  var text = typeof req.text === "string" ? req.text : "";
  if (!text) throw new Error("type needs text");
  if (text.length > 4000) throw new Error("type is limited to 4000 characters");
  var se = Application("System Events");
  var lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (i > 0) se.keyCode(36);
    var cells = lines[i].split("\t");
    for (var j = 0; j < cells.length; j++) {
      if (j > 0) se.keyCode(48);
      if (cells[j]) se.keystroke(cells[j]);
    }
  }
  return { typed: text.length };
}

// "cmd+shift+s", "escape", "ctrl+left" — the last token is the key.
function pressKey(req) {
  var combo = typeof req.keys === "string" ? req.keys.trim() : "";
  if (!combo) throw new Error("key needs keys, e.g. \"cmd+s\"");
  var parts = combo === "+" ? ["+"] : combo.split("+");
  if (combo.length > 1 && combo.slice(-2) === "++") {
    parts = combo.slice(0, -2).split("+").concat(["+"]);
  }
  var key = parts[parts.length - 1];
  var mods = modifiers(parts.slice(0, -1));
  var using = mods.map(function (m) {
    return SE_MOD[m];
  });
  var se = Application("System Events");
  var code = KEYCODES[key.toLowerCase().trim()];
  var opts = using.length ? { using: using } : {};
  if (code !== undefined) {
    se.keyCode(code, opts);
  } else if (key.length === 1) {
    se.keystroke(key.toLowerCase(), opts);
  } else {
    throw new Error('unknown key "' + key + '"');
  }
  return {};
}

function clip(value, max) {
  if (value === null || value === undefined) return "";
  var s = String(value).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fallbackLabel(el, pr) {
  var names = ["AXDescription", "AXIdentifier"];
  for (var i = 0; i < names.length; i++) {
    try {
      var v = clip(el.attributes.byName(names[i]).value(), 80);
      if (v) return v.replace(/^_NS:\d+$/, "");
    } catch (e) {}
  }
  return clip(String(pr.subrole || "").replace(/^AX/, ""), 80);
}

// The accessibility tree of the frontmost window, flattened to the elements
// a person could name or act on, each with the centre point to click.
function snapshot(req, geo) {
  var limit = Math.max(1, Math.min(400, Math.round(Number(req.limit) || 150)));
  var budgetMs = Math.max(500, Math.min(20000, Number(req.budgetMs) || 8000));
  var started = Date.now();
  var se = Application("System Events");
  var procs = se.processes.whose({ frontmost: true });
  if (!procs.length) throw new Error("no frontmost application");
  var proc = procs[0];
  var out = { app: proc.name(), window: "", elements: [], total: 0 };
  try {
    out.apps = se.processes.whose({ backgroundOnly: false }).name();
  } catch (e) {
    out.apps = [];
  }
  var win = null;
  try {
    var wins = proc.windows();
    for (var i = 0; i < wins.length && !win; i++) {
      try {
        if (wins[i].attributes.byName("AXMain").value()) win = wins[i];
      } catch (e) {}
    }
    if (!win && wins.length) win = wins[0];
  } catch (e) {}
  if (!win) {
    out.note = "the frontmost application has no window";
    return out;
  }
  try {
    out.window = clip(win.name(), 120);
  } catch (e) {}
  var all = win.entireContents();
  out.total = all.length;
  for (var k = 0; k < all.length; k++) {
    if (out.elements.length >= limit) {
      out.truncated = "limit";
      break;
    }
    if (Date.now() - started > budgetMs) {
      out.truncated = "time";
      break;
    }
    var pr;
    try {
      pr = all[k].properties();
    } catch (e) {
      continue;
    }
    var role = pr.role || "";
    var label = clip(
      pr.title || pr.name || pr.accessibilityDescription || pr.help,
      80,
    );
    var value = role === "AXSecureTextField" ? "" : clip(pr.value, 120);
    var interactive = !!INTERACTIVE[role];
    // Icon-only controls (calculator keys, toolbar and window buttons) keep
    // their name in attributes the property record leaves out. One extra
    // round trip each, so only for controls that would otherwise be blank.
    if (interactive && !label) label = fallbackLabel(all[k], pr);
    if (!interactive && !label && !(role === "AXStaticText" && value)) continue;
    var pos = pr.position;
    var size = pr.size;
    if (!pos || !size || size[0] <= 0 || size[1] <= 0) continue;
    var item = {
      role: role.replace(/^AX/, ""),
      x: Math.round((pos[0] + size[0] / 2) / geo.f),
      y: Math.round((pos[1] + size[1] / 2) / geo.f),
      w: Math.round(size[0] / geo.f),
      h: Math.round(size[1] / geo.f),
    };
    if (label) item.label = label;
    if (value && value !== label) item.value = value;
    if (pr.enabled === false) item.disabled = true;
    if (pr.focused === true) item.focused = true;
    out.elements.push(item);
  }
  return out;
}

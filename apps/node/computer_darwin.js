// JXA driver behind talon-node's `computer` command on macOS. Run as
//   osascript -l JavaScript -e <this file> '<request json>'
// and answers one JSON object on stdout. Everything here ships with macOS:
// CoreGraphics events for the pointer, System Events for the keyboard and
// the frontmost window's accessibility tree, and the AXUIElement API for
// the system's own UI (menu extras, Control Center, menus, panels) and for
// checking what a click hit. No helper binary, no cgo.
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
  var verify = req.verify !== false;
  var before = verify ? hitTest(pt, geo) : null;
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
  if (!verify) return {};
  // Let the UI settle, then read the same element again (a toggle reports
  // its new state) and whatever now sits under the pointer (a menu or
  // popover that opened, a sheet that replaced the control).
  delay(Math.max(0, Math.min(3000, Number(req.settleMs) || 400)) / 1000);
  var out = {};
  if (before) {
    out.target = before.item;
    var again = describeAX(before.el, geo, before.item.app);
    if (again) out.targetAfter = again;
    else out.targetGone = true;
  }
  var now = hitTest(pt, geo);
  if (now) out.under = now.item;
  return out;
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
  if (!combo) throw new Error('key needs keys, e.g. "cmd+s"');
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
  var scope = String(req.scope || "front").toLowerCase();
  if (scope !== "front" && scope !== "all") {
    throw new Error(
      'unknown snapshot scope "' + req.scope + '" (front or all)',
    );
  }
  if (scope === "all") {
    // System UI first: it is small, and it is what the frontmost window's
    // tree can never show (menu extras, Control Center, popovers, menus).
    // It gets at most half the time budget so the window still gets read.
    out.system = systemUI(proc, geo, limit, started + budgetMs / 2);
  }
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
    // Same on/off as scope "all" reports. value stays too, for daemons
    // that predate state.
    var state = toggleState({ AXRole: role, AXValue: Number(pr.value) });
    if (state && role !== "AXMenuItem" && value !== "") item.state = state;
    if (pr.enabled === false) item.disabled = true;
    if (pr.focused === true) item.focused = true;
    out.elements.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Direct accessibility (AXUIElement) access. System Events is fine for one
// window, but it costs an Apple Event per property and cannot reach the
// system's own UI well: menu extras, Control Center and its module
// popovers, open menus and floating panels all live in other processes. The
// AX C API reaches them in milliseconds. JXA quirks, verified on macOS 26
// and 27: the out-param must be Ref("^@"), and an element read back from
// one must be cast to an object before it can be passed in again.

var AX_ATTRS = [
  "AXRole",
  "AXSubrole",
  "AXTitle",
  "AXDescription",
  "AXValue",
  "AXHelp",
  "AXIdentifier",
  "AXEnabled",
  "AXFocused",
  "AXSelected",
  "AXPosition",
  "AXSize",
  "AXMenuItemMarkChar",
  "AXExpanded",
];

// Roles that hold an on/off state in AXValue (0 or 1).
var AX_TOGGLES = {
  AXCheckBox: 1,
  AXSwitch: 1,
  AXToggle: 1,
  AXRadioButton: 1,
  AXMenuItem: 1,
};

// Window owners that are scenery, not UI: walking them yields nothing a
// person could act on, or (the Dock) far more than anyone asked for.
// kCGStatusWindowLevel: the windows menu bar extras are drawn in.
var STATUS_LAYER = 25;

var SYSTEM_SKIP = {
  "Window Server": 1,
  Dock: 1,
  Wallpaper: 1,
  WindowManager: 1,
};

function axAttr(el, name) {
  var r = Ref("^@");
  if ($.AXUIElementCopyAttributeValue(el, $(name), r) !== 0) return null;
  return r[0] ? ObjC.castRefToObject(r[0]) : null;
}

function axApp(pid) {
  var app = $.AXUIElementCreateApplication(pid);
  // A hung app would otherwise stall every call for the 6s default.
  $.AXUIElementSetMessagingTimeout(app, 0.5);
  return app;
}

// One AX value as plain JSON: strings, numbers, booleans, and [x, y] /
// [w, h] pairs for points and sizes. Anything else (elements, errors) is
// null.
function axPlain(o) {
  if (!o) return null;
  var u;
  try {
    u = ObjC.unwrap(o);
  } catch (e) {
    return null;
  }
  if (
    typeof u === "string" ||
    typeof u === "number" ||
    typeof u === "boolean"
  ) {
    return u;
  }
  var d;
  try {
    d = String(o.description.js);
  } catch (e) {
    return null;
  }
  if (d.indexOf("kAXValueAXErrorType") >= 0) return null;
  var m =
    d.match(/x:(-?[\d.]+) y:(-?[\d.]+)/) ||
    d.match(/w:(-?[\d.]+) h:(-?[\d.]+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// All of AX_ATTRS for one element in a single round trip.
function axRead(el) {
  var r = Ref("^@");
  var names = $(AX_ATTRS);
  if (
    $.AXUIElementCopyMultipleAttributeValues(el, names, 0, r) !== 0 ||
    !r[0]
  ) {
    return null;
  }
  var values = ObjC.castRefToObject(r[0]);
  var out = {};
  for (var i = 0; i < AX_ATTRS.length && i < values.count; i++) {
    out[AX_ATTRS[i]] = axPlain(values.objectAtIndex(i));
  }
  return out;
}

function axChildren(el) {
  var kids = axAttr(el, "AXChildren");
  var out = [];
  if (!kids) return out;
  try {
    for (var i = 0; i < kids.count; i++) out.push(kids.objectAtIndex(i));
  } catch (e) {}
  return out;
}

// toggleState reads the on/off state of a control that has one: "on",
// "off" or "mixed" for checkboxes, switches, radio buttons and menu items
// with a check mark; "" for everything else.
function toggleState(a) {
  var role = a.AXRole || "";
  if (!AX_TOGGLES[role]) return "";
  if (role === "AXMenuItem") {
    var mark = a.AXMenuItemMarkChar;
    return mark ? "on" : "";
  }
  var v = a.AXValue;
  if (v === 1 || v === true) return "on";
  if (v === 0 || v === false) return "off";
  if (v === 2) return "mixed";
  return "";
}

// One element as a snapshot item, or null when it is nothing a person
// could name or act on, or it is off the primary display.
function axItem(a, geo, keepAll) {
  if (!a) return null;
  var role = a.AXRole || "";
  var label = clip(a.AXTitle || a.AXDescription || a.AXHelp, 80);
  var state = toggleState(a);
  var value = "";
  if (role !== "AXSecureTextField" && role !== "AXHeading" && !state) {
    var v = a.AXValue;
    if (typeof v === "string" || typeof v === "number") value = clip(v, 120);
  }
  var interactive = !!INTERACTIVE[role];
  if (interactive && !label) {
    label =
      clip(String(a.AXIdentifier || "").replace(/^_NS:\d+$/, ""), 80) ||
      clip(String(a.AXSubrole || "").replace(/^AX/, ""), 80);
  }
  if (
    !keepAll &&
    !interactive &&
    !label &&
    !(role === "AXStaticText" && value)
  ) {
    return null;
  }
  var pos = a.AXPosition;
  var size = a.AXSize;
  if (!pos || !size || size[0] <= 0 || size[1] <= 0) return null;
  var cx = (pos[0] + size[0] / 2) / geo.f;
  var cy = (pos[1] + size[1] / 2) / geo.f;
  if (cx < 0 || cy < 0 || cx > geo.w || cy > geo.h) return null;
  var item = {
    role: role.replace(/^AX/, ""),
    x: Math.round(cx),
    y: Math.round(cy),
    w: Math.round(size[0] / geo.f),
    h: Math.round(size[1] / geo.f),
  };
  if (label) item.label = label;
  if (value && value !== label) item.value = value;
  if (state) item.state = state;
  if (a.AXSelected === true && !state) item.selected = true;
  if (a.AXExpanded === true) item.expanded = true;
  if (a.AXEnabled === false) item.disabled = true;
  if (a.AXFocused === true) item.focused = true;
  return item;
}

// Walk one subtree depth-first into items. Submenus are not entered: an
// open submenu is its own on-screen window and is walked as one, and a
// closed one only holds stale positions.
function axWalk(root, geo, ctx, extra) {
  var stack = [[root, 0]];
  while (stack.length) {
    if (ctx.items.length >= ctx.limit) {
      ctx.truncated = "limit";
      return;
    }
    if (Date.now() > ctx.deadline) {
      ctx.truncated = "time";
      return;
    }
    var top = stack.pop();
    var a = axRead(top[0]);
    if (!a) continue;
    var item = a.AXRole === "AXWindow" ? null : axItem(a, geo, false);
    if (item && item.role === "MenuItem") {
      // Separators have no title; option-key alternates ("Force Quit
      // Telegram" under "Force Quit…") sit exactly on the item they replace.
      var spot = item.x + "," + item.y + "," + item.w;
      if (!item.label || ctx.seen[spot]) item = null;
      else ctx.seen[spot] = 1;
    }
    if (item) {
      for (var k in extra) item[k] = extra[k];
      ctx.items.push(item);
    }
    if (top[1] >= 40 || (a.AXRole === "AXMenuItem" && top[1] > 0)) continue;
    var kids = axChildren(top[0]);
    for (var i = kids.length - 1; i >= 0; i--)
      stack.push([kids[i], top[1] + 1]);
  }
}

function sameFrame(a, b) {
  return (
    a &&
    b &&
    Math.abs(a[0] - b[0]) <= 2 &&
    Math.abs(a[1] - b[1]) <= 2 &&
    Math.abs(a[2] - b[2]) <= 2 &&
    Math.abs(a[3] - b[3]) <= 2
  );
}

// The AX root behind one on-screen window: the app's AXWindow with the same
// frame, or — for menus, popovers and panels the app does not list as
// windows — whatever the window's centre hit-tests to, climbed to its menu
// or top-level element.
function axWindowRoot(app, frame) {
  var wins = axAttr(app, "AXWindows");
  if (wins) {
    for (var i = 0; i < wins.count; i++) {
      var w = wins.objectAtIndex(i);
      var p = axPlain(axAttr(w, "AXPosition"));
      var s = axPlain(axAttr(w, "AXSize"));
      if (p && s && sameFrame([p[0], p[1], s[0], s[1]], frame)) return w;
    }
  }
  var r = Ref("^@");
  var cx = frame[0] + frame[2] / 2;
  var cy = frame[1] + Math.min(frame[3] / 2, 24);
  if ($.AXUIElementCopyElementAtPosition(app, cx, cy, r) !== 0 || !r[0])
    return null;
  var el = ObjC.castRefToObject(r[0]);
  for (var depth = 0; depth < 40; depth++) {
    var role = axPlain(axAttr(el, "AXRole"));
    if (role === "AXMenu" || role === "AXWindow" || role === "AXSheet")
      return el;
    var parent = axAttr(el, "AXParent");
    if (!parent) return el;
    var prole = axPlain(axAttr(parent, "AXRole"));
    if (prole === "AXApplication") return el;
    el = parent;
  }
  return el;
}

function runningApps() {
  var out = [];
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) {
    var a = apps.objectAtIndex(i);
    out.push({
      pid: a.processIdentifier,
      name: a.localizedName.js || "",
      policy: Number(a.activationPolicy),
    });
  }
  return out;
}

// The system's UI around the frontmost window: the frontmost app's menu
// bar, every menu bar extra (status item, Control Center module), and the
// controls inside every other on-screen window that is not an ordinary app
// window — open menus, Control Center and its module popovers, Notification
// Center, floating panels. Ordinary windows of background apps are listed
// (owner, title, frame) but not walked.
function systemUI(frontProc, geo, limit, deadline) {
  var ctx = {
    items: [],
    limit: limit,
    deadline: deadline,
    truncated: "",
    seen: {},
  };
  var out = { menuBar: [], extras: [], windows: [], elements: ctx.items };
  var frontPid = -1;
  try {
    frontPid = frontProc.unixId();
  } catch (e) {}
  var apps = runningApps();
  var names = {};
  apps.forEach(function (a) {
    names[a.pid] = a;
  });

  // The frontmost app's own menus (Apple, File, Edit, …).
  if (frontPid > 0) {
    var bar = axAttr(axApp(frontPid), "AXMenuBar");
    axChildren(bar).forEach(function (el) {
      var item = axItem(axRead(el), geo, true);
      if (item && item.label)
        out.menuBar.push({ label: item.label, x: item.x, y: item.y });
    });
  }

  // Menu extras. On macOS 26 they hang off each owner's AXExtrasMenuBar;
  // on 27 the system ones are grouped under MenuBarAgent. Either way the
  // clickable thing is the AXMenuBarItem, sometimes one level down.
  for (var i = 0; i < apps.length && Date.now() < deadline; i++) {
    var extrasBar = axAttr(axApp(apps[i].pid), "AXExtrasMenuBar");
    if (!extrasBar) continue;
    var queue = axChildren(extrasBar).map(function (el) {
      return [el, 0];
    });
    while (queue.length) {
      var next = queue.shift();
      var a = axRead(next[0]);
      if (!a) continue;
      if (a.AXRole === "AXMenuBarItem") {
        var item = axItem(a, geo, true);
        if (item) {
          // Third-party extras often carry no name of their own.
          if (!item.label || item.label === "MenuExtra")
            item.label = apps[i].name;
          item.app = apps[i].name;
          delete item.role;
          out.extras.push(item);
        }
      } else if (next[1] < 3) {
        axChildren(next[0]).forEach(function (el) {
          queue.push([el, next[1] + 1]);
        });
      }
    }
  }
  out.extras.sort(function (a, b) {
    return a.x - b.x;
  });

  // Every other on-screen window, frontmost first.
  var list = [];
  try {
    list =
      ObjC.deepUnwrap(
        ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0)),
      ) || [];
  } catch (e) {}
  var frontWalked = false;
  var roots = [];
  list.forEach(function (w) {
    var b = w.kCGWindowBounds || {};
    var frame = [b.X, b.Y, b.Width, b.Height];
    var owner = String(w.kCGWindowOwnerName || "");
    var pid = w.kCGWindowOwnerPID;
    var layer = w.kCGWindowLayer || 0;
    if (!(b.Width >= 8 && b.Height >= 8) || SYSTEM_SKIP[owner]) return;
    // Status items are windows too (layer 25 on macOS 26, all owned by
    // Control Center); the extras list above already has them.
    if (layer === STATUS_LAYER) return;
    if (w.kCGWindowAlpha === 0) return;
    var cx = (b.X + b.Width / 2) / geo.f;
    var cy = (b.Y + b.Height / 2) / geo.f;
    if (cx < 0 || cy < 0 || cx > geo.w || cy > geo.h) return;
    var info = names[pid] || {};
    var regular = info.policy === 0;
    // The frontmost app's normal windows are the main snapshot's job.
    if (pid === frontPid && layer === 0) {
      if (!frontWalked) {
        frontWalked = true;
        return;
      }
    }
    var entry = {
      app: info.name || owner,
      x: Math.round(b.X / geo.f),
      y: Math.round(b.Y / geo.f),
      w: Math.round(b.Width / geo.f),
      h: Math.round(b.Height / geo.f),
    };
    var title = clip(w.kCGWindowName, 80);
    if (title) entry.title = title;
    if (layer) entry.layer = layer;
    out.windows.push(entry);
    // Ordinary app windows and desktop widgets (negative layers) are
    // listed, not walked: they are big, and seldom what was missed.
    if ((regular && layer === 0) || layer < 0) return;
    if (Date.now() > deadline || ctx.items.length >= limit) return;
    var root = axWindowRoot(axApp(pid), frame);
    if (!root) return;
    for (var j = 0; j < roots.length; j++) {
      if ($.CFEqual(roots[j], root)) return;
    }
    roots.push(root);
    var before = ctx.items.length;
    var tag = { app: entry.app };
    if (title) tag.window = title;
    axWalk(root, geo, ctx, tag);
    entry.walked = ctx.items.length - before;
  });
  if (ctx.truncated) out.truncated = ctx.truncated;
  return out;
}

// describeAX: one element as a compact item, with the app that owns it.
function describeAX(el, geo, app) {
  var a;
  try {
    a = axRead(el);
  } catch (e) {
    return null;
  }
  if (!a || !a.AXRole) return null;
  var item = axItem(a, geo, true) || {
    role: String(a.AXRole).replace(/^AX/, ""),
  };
  if (app) item.app = app;
  return item;
}

// hitTest: the element under a point (in screen points), climbed to the
// nearest control when the hit is a label or image inside one. Returns the
// element too, so a caller can read it again after acting on it.
function hitTest(pt, geo) {
  var wide = $.AXUIElementCreateSystemWide();
  $.AXUIElementSetMessagingTimeout(wide, 0.5);
  var r = Ref("^@");
  if ($.AXUIElementCopyElementAtPosition(wide, pt.x, pt.y, r) !== 0 || !r[0])
    return null;
  var el = ObjC.castRefToObject(r[0]);
  var hit = el;
  for (var depth = 0; depth < 4; depth++) {
    var role = axPlain(axAttr(el, "AXRole"));
    if (INTERACTIVE[role]) {
      hit = el;
      break;
    }
    var parent = axAttr(el, "AXParent");
    if (!parent) break;
    el = parent;
  }
  var app = "";
  try {
    var pid = Ref("i");
    if ($.AXUIElementGetPid(hit, pid) === 0) {
      var running =
        $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid[0]);
      if (running) app = running.localizedName.js || "";
    }
  } catch (e) {}
  var item = describeAX(hit, geo, app);
  return item ? { el: hit, item: item } : null;
}

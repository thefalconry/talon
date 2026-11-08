import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  /// Menu bar (status bar) presence. Talon lives here so the mesh keeps
  /// running when the window is closed: closing the window hides it (see
  /// MainFlutterWindow.windowShouldClose) instead of terminating the app,
  /// and this item is how you get back in — or quit for real.
  private var statusItem: NSStatusItem?

  /// First (disabled) menu row showing live status pushed from Dart over the
  /// "talon/menu_bar" method channel (see MainFlutterWindow).
  private let statusLine = NSMenuItem(
    title: "Starting…",
    action: nil,
    keyEquivalent: ""
  )

  /// The last `talon://pair` link macOS handed us, held until Dart asks for
  /// it over the "talon/pair" channel (see MainFlutterWindow and
  /// lib/src/services/pair_links.dart). A mailbox, like Android's
  /// PairBridge: a cold start delivers the URL before Dart is listening.
  private var pendingPairLink: String?

  override init() {
    super.init()
    // Registered this early so a cold start by a talon:// link (delivered
    // between will- and didFinishLaunching) isn't missed. A raw Apple Event
    // handler rather than application(_:open:) so it doesn't depend on
    // which NSApplicationDelegate methods FlutterAppDelegate implements.
    NSAppleEventManager.shared().setEventHandler(
      self,
      andSelector: #selector(handleGetURL(_:withReplyEvent:)),
      forEventClass: AEEventClass(kInternetEventClass),
      andEventID: AEEventID(kAEGetURL)
    )
  }

  // FlutterAppDelegate doesn't implement applicationDidFinishLaunching, so
  // calling super here raised an unrecognized-selector exception on every
  // launch (AppKit swallowed it).
  override func applicationDidFinishLaunching(_ notification: Notification) {
    setUpStatusItem()
  }

  @objc private func handleGetURL(
    _ event: NSAppleEventDescriptor,
    withReplyEvent reply: NSAppleEventDescriptor
  ) {
    guard
      let link = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?
        .stringValue,
      link.lowercased().hasPrefix("talon:")
    else { return }
    pendingPairLink = link
    // The link carries a bearer token; log that one arrived, never what.
    NSLog("Talon: pairing link received")
    // Bring the window forward: Dart checks for a link when the app resumes.
    showMainWindow()
  }

  /// Hands the pending pairing link over exactly once.
  func consumePairLink() -> String? {
    let link = pendingPairLink
    pendingPairLink = nil
    return link
  }

  // Keep running headless in the menu bar after the last window closes —
  // the mesh (locate/exec/teleport/file transfer) must survive the window.
  override func applicationShouldTerminateAfterLastWindowClosed(
    _ sender: NSApplication
  ) -> Bool {
    return false
  }

  override func applicationSupportsSecureRestorableState(
    _ app: NSApplication
  ) -> Bool {
    return true
  }

  // Dock icon click (or `open -a Talon` again) while the window is hidden.
  override func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    if !flag {
      showMainWindow()
    }
    return true
  }

  /// Called from the platform channel with a short human status line
  /// ("Connected · mesh active").
  func setMenuBarStatus(_ text: String) {
    statusLine.title = text
  }

  private func setUpStatusItem() {
    let item = NSStatusBar.system.statusItem(
      withLength: NSStatusItem.squareLength
    )
    if let button = item.button {
      var symbol: NSImage?
      if #available(macOS 11.0, *) {
        symbol =
          NSImage(
            systemSymbolName: "point.3.connected.trianglepath.dotted",
            accessibilityDescription: "Talon"
          )
          ?? NSImage(
            systemSymbolName: "antenna.radiowaves.left.and.right",
            accessibilityDescription: "Talon"
          )
      }
      if let symbol = symbol {
        symbol.isTemplate = true
        button.image = symbol
      } else {
        // Pre-SF-Symbols macOS: fall back to the app icon.
        let icon = NSApp.applicationIconImage.copy() as! NSImage
        icon.size = NSSize(width: 18, height: 18)
        button.image = icon
      }
      button.toolTip = "Talon"
    }

    let menu = NSMenu()
    // autoenablesItems (default) greys out items with no action — exactly
    // what we want for the status line.
    menu.addItem(statusLine)
    menu.addItem(.separator())
    let open = NSMenuItem(
      title: "Open Talon",
      action: #selector(openTalon),
      keyEquivalent: "o"
    )
    open.target = self
    menu.addItem(open)
    menu.addItem(.separator())
    let quit = NSMenuItem(
      title: "Quit Talon",
      action: #selector(quitTalon),
      keyEquivalent: "q"
    )
    quit.target = self
    menu.addItem(quit)

    item.menu = menu
    statusItem = item
  }

  @objc private func openTalon() {
    showMainWindow()
  }

  @objc private func quitTalon() {
    NSApp.terminate(nil)
  }

  private func showMainWindow() {
    NSApp.activate(ignoringOtherApps: true)
    for window in NSApp.windows where window is MainFlutterWindow {
      window.makeKeyAndOrderFront(nil)
    }
  }
}

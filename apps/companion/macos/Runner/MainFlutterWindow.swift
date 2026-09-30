import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow, NSWindowDelegate {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)

    // Dart pushes a short status line for the menu bar item's first row
    // ("Connected · mesh active") — see lib/src/services/menu_bar.dart.
    let menuBarChannel = FlutterMethodChannel(
      name: "talon/menu_bar",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    menuBarChannel.setMethodCallHandler { call, result in
      switch call.method {
      case "setStatus":
        if let text = call.arguments as? String {
          (NSApp.delegate as? AppDelegate)?.setMenuBarStatus(text)
        }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    // talon://pair links (the last hop of the daemon's /mesh pair page),
    // held by AppDelegate until Dart consumes them — see
    // lib/src/services/pair_links.dart.
    let pairChannel = FlutterMethodChannel(
      name: "talon/pair",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    pairChannel.setMethodCallHandler { call, result in
      switch call.method {
      case "consume":
        result((NSApp.delegate as? AppDelegate)?.consumePairLink())
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    self.delegate = self

    super.awakeFromNib()
  }

  // Closing the window (red button / Cmd-W) hides it instead of quitting:
  // the app stays resident in the menu bar and the mesh keeps answering.
  // Quit for real via the menu bar item or Cmd-Q.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    orderOut(nil)
    return false
  }
}

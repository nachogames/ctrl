import ExpoModulesCore
import UIKit

/// Solid is the primary icon (the Icon Composer project); the others are asset-catalog
/// alternate icon sets written by plugins/withCtrlAppIcons.cjs.
public final class CtrlAppIconModule: Module {
  private static let alternateIconNames: [String: String] = [
    "outline": "AppIconOutline",
    "mac": "AppIconMac",
  ]

  public func definition() -> ModuleDefinition {
    Name("CtrlAppIcon")

    AsyncFunction("getAppIcon") { () -> String in
      guard let name = UIApplication.shared.alternateIconName else { return "solid" }
      return Self.alternateIconNames.first(where: { $0.value == name })?.key ?? "solid"
    }.runOnQueue(.main)

    AsyncFunction("setAppIcon") { (design: String, promise: Promise) in
      guard UIApplication.shared.supportsAlternateIcons else {
        promise.reject("ERR_APP_ICON_UNSUPPORTED", "This device does not support alternate app icons.")
        return
      }
      let name = design == "solid" ? nil : Self.alternateIconNames[design]
      if design != "solid" && name == nil {
        promise.reject("ERR_APP_ICON_UNKNOWN", "Unknown app icon \(design).")
        return
      }
      UIApplication.shared.setAlternateIconName(name) { error in
        if let error {
          promise.reject("ERR_APP_ICON_FAILED", error.localizedDescription)
        } else {
          promise.resolve(nil)
        }
      }
    }.runOnQueue(.main)
  }
}

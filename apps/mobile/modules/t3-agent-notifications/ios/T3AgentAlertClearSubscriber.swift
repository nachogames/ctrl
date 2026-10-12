import ExpoModulesCore
import UIKit
import UserNotifications

/// Removes a thread's delivered alerts when the server's silent push says its
/// question was answered. Alerts are matched by the APNs `thread-id` the
/// server sets on them, which the clear push names as `t3_clear_thread`.
public final class T3AgentAlertClearSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    guard let thread = userInfo["t3_clear_thread"] as? String, !thread.isEmpty else {
      completionHandler(.noData)
      return
    }
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { notifications in
      let identifiers = notifications
        .filter { $0.request.content.threadIdentifier == thread }
        .map(\.request.identifier)
      center.removeDeliveredNotifications(withIdentifiers: identifiers)
      completionHandler(identifiers.isEmpty ? .noData : .newData)
    }
  }
}

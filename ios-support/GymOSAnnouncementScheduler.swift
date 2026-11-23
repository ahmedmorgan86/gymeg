//
//  GymOSAnnouncementScheduler.swift
//  GymEG iOS Integration
//
//  Handles scheduled announcements via iOS UNUserNotificationCenter and native audio playback.
//  Maintains Apple's strict < 30s custom sound limit for UNNotificationSound.
//

import Foundation
import UserNotifications
import WebKit
import AVFoundation

@objc public final class GymOSAnnouncementScheduler: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    public static let shared = GymOSAnnouncementScheduler()
    private let messageHandlerName = "gymosAnnouncementBridge"
    private var audioPlayer: AVAudioPlayer?

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// Attaches the native script message handler to WKWebView configuration
    public func attach(to userContentController: WKUserContentController) {
        userContentController.add(self, name: messageHandlerName)
    }

    /// Requests notification permissions from the user
    public func requestPermissions(completion: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                completion(granted)
            }
        }
    }

    // MARK: - WKScriptMessageHandler
    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == messageHandlerName,
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }

        switch action {
        case "sync":
            if let items = body["items"] as? [[String: Any]] {
                syncAnnouncements(items: items)
            }
        case "playNow":
            if let wavBase64 = body["wavBase64"] as? String {
                playNow(wavBase64: wavBase64)
            }
        case "cancel":
            if let id = body["id"] as? String {
                cancelAnnouncement(id: id)
            }
        default:
            break
        }
    }

    // MARK: - Scheduling
    public func syncAnnouncements(items: [[String: Any]]) {
        // Clear old scheduled GymEG notifications
        UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
            let gymegIds = requests.filter { $0.identifier.hasPrefix("gymeg_ann_") }.map { $0.identifier }
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: gymegIds)

            for item in items {
                guard let id = item["id"] as? String,
                      let name = item["name"] as? String,
                      let times = item["times"] as? [String],
                      let enabled = item["enabled"] as? Bool, enabled else {
                    continue
                }

                // If unified composed audio base64 is provided, persist it in Library/Sounds/
                var customSoundName: String? = nil
                if let b64 = item["wavBase64"] as? String,
                   let audioData = Data(base64Encoded: b64) {
                    customSoundName = self.saveSoundToLibrary(id: id, data: audioData)
                }

                // Schedule local notification for each daily time
                for (index, timeStr) in times.enumerated() {
                    let parts = timeStr.trimmingCharacters(in: .whitespaces).split(separator: ":")
                    guard parts.count == 2,
                          let hour = Int(parts[0]),
                          let minute = Int(parts[1]) else {
                        continue
                    }

                    var dateComponents = DateComponents()
                    dateComponents.hour = hour
                    dateComponents.minute = minute
                    dateComponents.second = 0

                    let trigger = UNCalendarNotificationTrigger(dateMatching: dateComponents, repeats: true)

                    let content = UNMutableNotificationContent()
                    content.title = name.isEmpty ? "نداء صوتي مجدول" : name
                    content.body = "موعد النداء الصوتي في الصالة الرياضية"

                    if let soundName = customSoundName {
                        // UNNotificationSound strictly requires audio files < 30s located in Library/Sounds or bundle
                        content.sound = UNNotificationSound(named: UNNotificationSoundName(soundName))
                    } else {
                        content.sound = .default
                    }

                    let requestIdentifier = "gymeg_ann_\(id)_\(index)"
                    let request = UNNotificationRequest(identifier: requestIdentifier, content: content, trigger: trigger)

                    UNUserNotificationCenter.current().add(request) { error in
                        if let error = error {
                            print("[GymOS] Failed to schedule notification: \(error.localizedDescription)")
                        }
                    }
                }
            }
        }
    }

    public func playNow(wavBase64: String) {
        guard let data = Data(base64Encoded: wavBase64) else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.duckOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            audioPlayer = try AVAudioPlayer(data: data)
            audioPlayer?.play()
        } catch {
            print("[GymOS] Failed to play native audio: \(error)")
        }
    }

    public func cancelAnnouncement(id: String) {
        UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
            let targetIds = requests.filter { $0.identifier.contains("gymeg_ann_\(id)") }.map { $0.identifier }
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: targetIds)
        }
    }

    private func saveSoundToLibrary(id: String, data: Data) -> String? {
        guard let libraryDir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else {
            return nil
        }
        let soundsDir = libraryDir.appendingPathComponent("Sounds", isDirectory: true)
        try? FileManager.default.createDirectory(at: soundsDir, withIntermediateDirectories: true, attributes: nil)

        let filename = "ann_\(id).wav"
        let fileUrl = soundsDir.appendingPathComponent(filename)

        do {
            try data.write(to: fileUrl)
            return filename
        } catch {
            print("[GymOS] Error writing sound file to Library/Sounds: \(error)")
            return nil
        }
    }

    // MARK: - UNUserNotificationCenterDelegate
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Show notification with sound even when app is active in foreground
        if #available(iOS 14.0, *) {
            completionHandler([.banner, .sound, .list])
        } else {
            completionHandler([.alert, .sound])
        }
    }
}

import SwiftUI
import UserNotifications

@main
struct GymEGMembersApp: App {
    @StateObject private var coordinator = WebViewCoordinator()

    var body: some Scene {
        WindowGroup {
            MemberContentView(coordinator: coordinator)
                .onOpenURL { url in
                    coordinator.handleUniversalLink(url)
                }
                .task {
                    let center = UNUserNotificationCenter.current()
                    _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
                }
        }
    }
}

struct MemberContentView: View {
    @ObservedObject var coordinator: WebViewCoordinator

    var body: some View {
        ZStack {
            MemberWebView(coordinator: coordinator)
                .ignoresSafeArea(.container, edges: .bottom)

            if coordinator.hasNetworkError {
                VStack(spacing: 14) {
                    Image(systemName: "wifi.slash")
                        .font(.system(size: 40))
                        .foregroundColor(.purple)
                    Text("تعذر الاتصال بالخادم")
                        .font(.headline)
                    Text("تحقق من اتصال الإنترنت ثم أعد المحاولة.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    Button("إعادة المحاولة / Retry") {
                        coordinator.reload()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.purple)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemBackground))
            }
        }
    }
}

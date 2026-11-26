import SwiftUI
import WebKit
import AuthenticationServices

@MainActor
final class WebViewCoordinator: NSObject, ObservableObject, WKNavigationDelegate, ASWebAuthenticationPresentationContextProviding {
    static let allowedOrigin = "https://gymeg.vercel.app"
    static let homeURL = URL(string: "\(allowedOrigin)/member")!

    @Published var hasNetworkError = false
    weak var webView: WKWebView?
    private var authSession: ASWebAuthenticationSession?

    func reload() {
        hasNetworkError = false
        webView?.load(URLRequest(url: Self.homeURL))
    }

    func handleUniversalLink(_ url: URL) {
        guard url.scheme == "https", url.host == "gymeg.vercel.app" else { return }
        hasNetworkError = false
        webView?.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        // Handle Google OAuth via ASWebAuthenticationSession so cookies/sessions stay native & App Store compliant
        if url.host == "accounts.google.com" || url.path.hasPrefix("/api/auth/google") {
            decisionHandler(.cancel)
            startOAuth(url: url)
            return
        }

        // Allow only HTTPS within gymeg.vercel.app; open external payment links (Paymob/Fawry/InstaPay) in Safari
        if url.scheme == "https" {
            if url.host == "gymeg.vercel.app" {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated {
                UIApplication.shared.open(url)
            }
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasNetworkError = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        hasNetworkError = true
    }

    private func startOAuth(url: URL) {
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "gymeg-member") { [weak self] callbackURL, _ in
            guard let self, let callbackURL else { return }
            Task { @MainActor in
                if let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                   let code = components.queryItems?.first(where: { $0.name == "code" })?.value {
                    let exchangeURL = URL(string: "\(Self.allowedOrigin)/auth/mobile/callback/members?code=\(code)")!
                    self.webView?.load(URLRequest(url: exchangeURL))
                } else {
                    self.webView?.load(URLRequest(url: Self.homeURL))
                }
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.authSession = session
        session.start()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

struct MemberWebView: UIViewRepresentable {
    @ObservedObject var coordinator: WebViewCoordinator

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = coordinator
        webView.allowsBackForwardNavigationGestures = true
        coordinator.webView = webView

        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(RefreshHelper.handleRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        webView.load(URLRequest(url: WebViewCoordinator.homeURL))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> RefreshHelper {
        RefreshHelper(coordinator: coordinator)
    }

    final class RefreshHelper: NSObject {
        let coordinator: WebViewCoordinator
        init(coordinator: WebViewCoordinator) { self.coordinator = coordinator }
        @objc func handleRefresh(_ sender: UIRefreshControl) {
            coordinator.webView?.reload()
            sender.endRefreshing()
        }
    }
}

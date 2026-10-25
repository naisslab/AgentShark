import AppKit
import SwiftUI
import WebKit

/// The engine's research tools page (`/workbench.html`). Critical Path and Compare are native Session modes; the other
/// tools open in the browser, where their downloads and file inputs work (ANALYSIS-UX §6.1).
enum ResearchTools {
    /// The page with the engine's token, which authenticates it. The token therefore lands in the browser's history.
    static func url(for endpoint: EngineEndpoint) -> URL? {
        var components = URLComponents(url: endpoint.baseURL.appendingPathComponent("workbench.html"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "token", value: endpoint.token)]
        return components?.url
    }

    /// Analyze ▸ Open Research Tools in Browser, and the demo window's Open in Browser: the page in the default browser.
    /// Does nothing while the engine is not ready.
    @MainActor static func open(engine: EngineProcess) {
        guard let url = engine.endpoint.flatMap(url(for:)) else { return }
        NSWorkspace.shared.open(url)
    }
}

/// Analyze ▸ Explore Bundled Demo (ANALYSIS-UX §6.2): the research tools on the demo engine, which runs only while this
/// window is open and indexes a bundled synthetic sample into a temporary index. A page that fails to load says so, with
/// Retry and Open in Browser, instead of staying blank.
struct DemoWorkbenchWindow: View {
    let app: AppModel
    @State private var page = DemoPage()

    private var engine: EngineProcess { app.demoEngine }

    var body: some View {
        Group {
            if let endpoint = engine.endpoint, let url = ResearchTools.url(for: endpoint) {
                LocalWorkbench(url: url, page: page)
                    .id(endpoint)
                    .overlay { if let failure = page.failure { failed(failure) } }
            } else {
                EngineStateView(engine: engine)
            }
        }
        .frame(minWidth: 900, minHeight: 620)
        .navigationSubtitle("Synthetic sample · temporary index")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Open in Browser", systemImage: "safari") { ResearchTools.open(engine: engine) }
                    .labelStyle(.titleAndIcon)
                    .disabled(engine.endpoint == nil)
                    .help("Open the demo in your browser, where downloads and file inputs work. The demo engine stops when this window closes.")
            }
        }
        .onAppear { engine.start() }
        .onDisappear { engine.stop() }
    }

    private func failed(_ reason: String) -> some View {
        ContentUnavailableView {
            Label { Text(DemoPage.message(reason)).textSelection(.enabled) } icon: { Image(systemName: "exclamationmark.triangle") }
        } actions: {
            Button("Retry") { page.retry() }.keyboardShortcut(.defaultAction)
            Button("Open in Browser") { ResearchTools.open(engine: engine) }
        }
        .background(.background)
    }
}

/// The demo page's load state, shared by the web view's navigation delegate and the window's failure overlay.
@MainActor @Observable final class DemoPage {
    /// Why the page is not showing, as WebKit words it; nil while it loads or shows.
    private(set) var failure: String?
    @ObservationIgnored weak var webView: WKWebView?
    @ObservationIgnored var url: URL?

    /// The overlay's one sentence (ANALYSIS-UX §6.2): "Could not load the demo workbench: Could not connect to the server."
    static func message(_ reason: String) -> String {
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return "Could not load the demo workbench: \(reason.hasSuffix(".") ? String(reason.dropLast()) : reason)."
    }

    func loadStarted() { failure = nil }

    /// A failed load replaces the page with the overlay, except where the page stays as it was: a navigation that a newer
    /// one replaced, or one stopped by policy (WebKitErrorFrameLoadInterruptedByPolicyChange: a refused link, or a
    /// download the web view cannot save).
    func loadFailed(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain", e.code == 102 { return }
        failure = e.localizedDescription
    }

    func processTerminated() { failure = "The page's web content process stopped" }

    /// Reload the page. A failed first load leaves the web view no page to reload, so it loads the page's URL instead.
    func retry() {
        failure = nil
        guard let webView else { return }
        if webView.backForwardList.currentItem != nil {
            webView.reload()
        } else if let url {
            webView.load(URLRequest(url: url))
        }
    }
}

private struct LocalWorkbench: NSViewRepresentable {
    let url: URL
    let page: DemoPage

    func makeCoordinator() -> Coordinator { Coordinator(origin: url, page: page) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // WebKit asks AppSSO before every navigation whether a single sign-on extension handles the URL. On some Macs
        // that question is never answered and the page stays blank; no extension handles the engine's local page.
        if configuration.preferences.responds(to: NSSelectorFromString("_setExtensibleSSOEnabled:")) {
            configuration.preferences.setValue(false, forKey: "extensibleSSOEnabled")
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        // Overscroll and the moment before the first paint show the window's color, not a white slab in Dark Mode.
        view.underPageBackgroundColor = .windowBackgroundColor
        view.isInspectable = true
        page.webView = view
        page.url = url
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        let origin: URL
        let page: DemoPage

        init(origin: URL, page: DemoPage) {
            self.origin = origin
            self.page = page
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let destination = action.request.url else { decisionHandler(.cancel); return }
            if destination.scheme == origin.scheme, destination.host == origin.host, destination.port == origin.port {
                decisionHandler(.allow)
            } else { decisionHandler(.cancel) }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            page.loadStarted()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            page.loadFailed(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            page.loadFailed(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            page.processTerminated()
        }
    }
}

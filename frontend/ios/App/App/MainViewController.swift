import Capacitor
import UIKit
import UserNotifications
import WebKit

/**
 * The app's own bridge view controller (Main.storyboard). Since Capacitor 6 the bridge only loads
 * the plugins that come from npm packages (packageClassList in capacitor.config.json); plugins
 * that live in the app itself are registered here, or the page finds none of them.
 */
class MainViewController: CAPBridgeViewController {
    /// The downloaded animation packs, read through Background Assets (AnimationPacksPlugin.swift).
    private let packFiles = AnimationPackSchemeHandler()

    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.setURLSchemeHandler(packFiles, forURLScheme: AnimationPackSchemeHandler.scheme)
        // Settings → Accessibility → Reduce Transparency, which a web view's CSS cannot see: the
        // page's glass (index.css, Liquid Glass) turns solid on :root[data-reduce-transparency].
        config.userContentController.addUserScript(WKUserScript(
            source: MainViewController.transparencyScript(UIAccessibility.isReduceTransparencyEnabled),
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        return config
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrintPlugin())
        bridge?.registerPluginInstance(RestAlertPlugin())
        bridge?.registerPluginInstance(DeviceAuthPlugin())
        bridge?.registerPluginInstance(AnimationPacksPlugin())
        bridge?.registerPluginInstance(NudgeCheckPlugin())
        bridge?.registerPluginInstance(WatchBridgePlugin())
        bridge?.registerPluginInstance(AppleHealthPlugin())
        bridge?.registerPluginInstance(WidgetBridgePlugin())
        bridge?.registerPluginInstance(LiveActivityPlugin())
        WidgetPreview.runIfAsked()
        loadObservation = webView?.observe(\.isLoading, options: [.new]) { [weak self] web, _ in
            guard !web.isLoading else { return }
            DispatchQueue.main.async { self?.sentInsets = nil; self?.passReservedRegions() }
        }
        // Switched while the app runs: the page follows at once.
        NotificationCenter.default.addObserver(forName: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            self?.webView?.evaluateJavaScript(MainViewController.transparencyScript(UIAccessibility.isReduceTransparencyEnabled))
        }
        // After loadView has finished: the view is the web view only once it has.
        if ProcessInfo.processInfo.arguments.contains(MainViewController.pendingProbeArgument) {
            DispatchQueue.main.async { [weak self] in self?.showPendingProbe() }
        }
    }

    /* ---------- the iPhone Duo's reserved regions ---------- */

    /// The edges last handed to the page, so a layout pass that changes nothing sends nothing.
    private var sentInsets: UIEdgeInsets?
    /// A page (re)loaded starts without them: sent again each time one finishes loading.
    private var loadObservation: NSKeyValueObservation?

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        passReservedRegions()
    }

    /**
     * The folded iPhone Duo keeps a region of the screen for its camera and status pill (a
     * "reserved region", iOS 27.1). It is not part of the safe area a web view's
     * env(safe-area-inset-*) reports, so the page laid its bars and its message box under it.
     * Each active region is handed to the page as the edge it sits against (--native-sat, -sar,
     * -sab, -sal; index.css takes the larger of those and env()), which is all the layout needs.
     */
    private func passReservedRegions() {
        guard #available(iOS 27.1, *), let web = webView else { return }
        let rects = web.reservedRegions(kind: .occlusion).filter { $0.isActive }.map { $0.frame }
        let insets = MainViewController.edgeInsets(of: rects, in: web.bounds)
        guard insets != sentInsets else { return }
        sentInsets = insets
        web.evaluateJavaScript(MainViewController.insetScript(insets))
    }

    /// The inset each region asks of the edge it is nearest to, the largest per edge.
    static func edgeInsets(of rects: [CGRect], in bounds: CGRect) -> UIEdgeInsets {
        var e = UIEdgeInsets.zero
        for rect in rects {
            let r = rect.intersection(bounds)
            guard !r.isNull, r.width > 0, r.height > 0 else { continue }
            let gaps = [(bounds.maxX - r.maxX, 0), (r.minX - bounds.minX, 1), (r.minY - bounds.minY, 2), (bounds.maxY - r.maxY, 3)]
            switch gaps.min(by: { $0.0 < $1.0 })!.1 {
            case 0: e.right = max(e.right, bounds.maxX - r.minX)
            case 1: e.left = max(e.left, r.maxX - bounds.minX)
            case 2: e.top = max(e.top, r.maxY - bounds.minY)
            default: e.bottom = max(e.bottom, bounds.maxY - r.minY)
            }
        }
        return e
    }

    static func insetScript(_ e: UIEdgeInsets) -> String {
        let px = { (v: CGFloat) in "\(Int(v.rounded(.up)))px" }
        return "(function(s){s.setProperty('--native-sat','\(px(e.top))');s.setProperty('--native-sar','\(px(e.right))');"
            + "s.setProperty('--native-sab','\(px(e.bottom))');s.setProperty('--native-sal','\(px(e.left))')})(document.documentElement.style)"
    }

    /**
     * For the UI tests only (ios/App/AppUITests): launched with this argument, the app shows the
     * ids of the local notifications iOS holds for it, as a tiny label a test can read. A UI test
     * runs in its own process and cannot ask UNUserNotificationCenter about another app, and this
     * is what iOS really has pending, not what the page meant to schedule. Never shown otherwise:
     * nothing but XCUIApplication.launchArguments passes the argument.
     */
    static let pendingProbeArgument = "-OpenGymUITestPending"

    /// The page told whether Reduce Transparency is on.
    static func transparencyScript(_ on: Bool) -> String {
        "document.documentElement.toggleAttribute('data-reduce-transparency', \(on))"
    }

    private func showPendingProbe() {
        // On the window, not inside the web view: what a WKWebView holds is its page as far as
        // accessibility goes, and a label among its subviews may never reach the test.
        guard let host = view.window else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.showPendingProbe() }
            return
        }
        let label = UILabel()
        label.accessibilityIdentifier = "og-pending-notifications"
        label.font = .systemFont(ofSize: 8)
        label.textColor = .systemGray
        label.numberOfLines = 1
        label.isUserInteractionEnabled = false
        label.text = "pending:"
        label.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -2),
        ])
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak label] _ in
            UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
                let ids = requests.map { $0.identifier }.sorted().joined(separator: ",")
                DispatchQueue.main.async {
                    guard let label = label else { return }
                    label.text = "pending:" + ids
                    label.accessibilityLabel = "pending:" + ids
                    label.superview?.bringSubviewToFront(label)
                }
            }
        }
    }
}

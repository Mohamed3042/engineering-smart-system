import AppKit
import WebKit
import Foundation

final class DesktopApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var engine: Process?
    var logHandle: FileHandle?
    var startupTimer: Timer?
    var startupDeadline = Date()
    var quitting = false
    var ready = false
    var requestInFlight = false
    var awaitingSignIn = false
    var port = 8765
    let launchID = UUID().uuidString
    var downloads: [ObjectIdentifier: (WKDownload, URL, URL)] = [:]
    let resources = Bundle.main.resourceURL!
    lazy var dataDirectory: URL = {
        if let path = ProcessInfo.processInfo.environment["ESS_DATA_DIR"] { return URL(fileURLWithPath: path, isDirectory: true) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Engineering Smart System/data", isDirectory: true)
    }()
    lazy var release: [String: Any] = {
        guard let data = try? Data(contentsOf: resources.appendingPathComponent("release.json")),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }()
    lazy var network: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1.5
        config.timeoutIntervalForResource = 2
        return URLSession(configuration: config)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        makeMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Engineering Smart System"
        window.minSize = NSSize(width: 820, height: 620)
        window.contentView = webView
        window.setFrameAutosaveName("MainWorkspaceWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("""
        <!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
        <body style="font-family:-apple-system,sans-serif;background:#090f14;color:#eef4f4;display:grid;place-items:center;height:100vh;margin:0">
        <main><h1 style="font-size:26px">Engineering Smart System</h1><p>Opening your workspace…</p></main></body></html>
        """, baseURL: nil)
        startEngine()
    }

    func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Engineering Smart System", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Engineering Smart System", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Engineering Smart System", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appendMenu(file, to: menu)
        let edit = NSMenu(title: "Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"),
                                       ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        appendMenu(edit, to: menu)
        let view = NSMenu(title: "View")
        for (title, action, key) in [("Back", #selector(goBack), "["), ("Forward", #selector(goForward), "]"),
                                     ("Reload", #selector(reload), "r"), ("Zoom In", #selector(zoomIn), "+"),
                                     ("Zoom Out", #selector(zoomOut), "-"), ("Actual Size", #selector(actualSize), "0")] {
            let item = view.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.target = self
        }
        appendMenu(view, to: menu)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        appendMenu(windowMenu, to: menu)
        NSApp.windowsMenu = windowMenu
        let help = NSMenu(title: "Help")
        let dataItem = help.addItem(withTitle: "Show Data Folder", action: #selector(showData), keyEquivalent: "")
        dataItem.target = self
        appendMenu(help, to: menu)
        NSApp.mainMenu = menu
    }

    func appendMenu(_ submenu: NSMenu, to menu: NSMenu) {
        let item = NSMenuItem(title: submenu.title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        menu.addItem(item)
    }
    @objc func goBack() { webView.goBack() }
    @objc func goForward() { webView.goForward() }
    @objc func reload() { webView.reload() }
    @objc func zoomIn() { webView.pageZoom = min(2, webView.pageZoom + 0.1) }
    @objc func zoomOut() { webView.pageZoom = max(0.6, webView.pageZoom - 0.1) }
    @objc func actualSize() { webView.pageZoom = 1 }
    @objc func showData() { NSWorkspace.shared.open(dataDirectory) }

    func startEngine() {
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            let logURL = dataDirectory.appendingPathComponent("desktop-engine.log")
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
            logHandle = try FileHandle(forWritingTo: logURL)
            try logHandle?.seekToEnd()
            let process = Process()
            process.executableURL = resources.appendingPathComponent("python/bin/python3.12")
            process.arguments = ["-s", resources.appendingPathComponent("engine.py").path]
            process.currentDirectoryURL = dataDirectory
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = logHandle
            process.standardError = logHandle
            var env = ProcessInfo.processInfo.environment
            for key in ["PYTHONPATH", "PYTHONHOME", "ESS_CHROMIUM_PATH"] { env.removeValue(forKey: key) }
            env["PYTHONHOME"] = resources.appendingPathComponent("python").path
            env["PYTHONNOUSERSITE"] = "1"
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["PYTHONUNBUFFERED"] = "1"
            env["PYTHONUTF8"] = "1"
            env["ESS_DATA_DIR"] = dataDirectory.path
            env["ESS_LAUNCH_ID"] = launchID
            env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
            process.environment = env
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.startupTimer?.invalidate()
                    if self.quitting { NSApp.reply(toApplicationShouldTerminate: true) }
                    else { self.fail("The workspace engine stopped. Your saved data is still in the data folder.") }
                }
            }
            engine = process
            try process.run()
            startupDeadline = Date().addingTimeInterval(60)
            startupTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.checkReady() }
        } catch { fail("The workspace could not start: \(error.localizedDescription)") }
    }

    func checkReady() {
        if Date() > startupDeadline { startupTimer?.invalidate(); fail("The workspace did not finish starting. Its diagnostic log is in the data folder."); return }
        guard !requestInFlight,
              let data = try? Data(contentsOf: dataDirectory.appendingPathComponent("desktop-runtime.json")),
              let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              receipt["launch_id"] as? String == launchID, let runningPort = receipt["port"] as? Int else { return }
        port = runningPort
        requestInFlight = true
        let url = URL(string: "http://127.0.0.1:\(port)/api/health")!
        network.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.requestInFlight = false
                guard !self.ready, !self.quitting, let data = data,
                      let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      health["ok"] as? Bool == true,
                      health["version"] as? String == self.release["version"] as? String,
                      health["build_commit"] as? String == self.release["commit"] as? String else { return }
                self.ready = true
                self.startupTimer?.invalidate()
                self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/")!))
            }
        }.resume()
    }

    func fail(_ message: String) {
        guard !quitting else { return }
        let alert = NSAlert()
        alert.messageText = "Engineering Smart System could not open"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Show Data Folder")
        if alert.runModal() == .alertSecondButtonReturn { showData() }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        startupTimer?.invalidate()
        guard let engine = engine, engine.isRunning else { return .terminateNow }
        engine.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            if engine.isRunning { kill(engine.processIdentifier, SIGKILL) }
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
    func applicationDidBecomeActive(_ notification: Notification) {
        if awaitingSignIn && ready { awaitingSignIn = false; webView.reload() }
    }

    func internalURL(_ url: URL) -> Bool {
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == port
    }
    func openExternal(_ url: URL) {
        guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        if url.host == "accounts.google.com" { awaitingSignIn = true }
        NSWorkspace.shared.open(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if internalURL(url) || url.scheme == "about" || url.absoluteString.hasPrefix("blob:http://127.0.0.1:\(port)/") {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.targetFrame?.isMainFrame != false { openExternal(url) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(!navigationResponse.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if internalURL(url) || url.absoluteString.hasPrefix("blob:http://127.0.0.1:\(port)/") { webView.load(navigationAction.request) }
            else { openExternal(url) }
        }
        return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let destination = panel.url else { completionHandler(nil); return }
            let staging = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".download")
            self.downloads[ObjectIdentifier(download)] = (download, staging, destination)
            completionHandler(staging)
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let (_, staging, destination) = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.path) { _ = try FileManager.default.replaceItemAt(destination, withItemAt: staging) }
            else { try FileManager.default.moveItem(at: staging, to: destination) }
        } catch {
            let alert = NSAlert(); alert.messageText = "The download could not be saved"; alert.informativeText = error.localizedDescription
            alert.beginSheetModal(for: window)
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let (_, staging, _) = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: staging) }
        let alert = NSAlert(); alert.messageText = "The download did not finish"; alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }
}

let app = NSApplication.shared
let delegate = DesktopApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

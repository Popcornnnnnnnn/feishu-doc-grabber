import AppKit
import Combine
import SwiftUI

struct ExportReport: Decodable {
    let documents: [ExportDocument]
}

struct ExportDocument: Decodable, Identifiable {
    let url: String
    let output: String?
    let operationalStatus: String
    let error: String?
    let integrity: IntegrityResult

    var id: String { url }
    var displayName: String {
        if let output { return URL(fileURLWithPath: output).lastPathComponent }
        return URL(string: url)?.lastPathComponent ?? url
    }
    var status: String {
        operationalStatus == "success" ? integrity.verdict : "failed"
    }
    var detail: String {
        if let error, !error.isEmpty { return error }
        let issues = integrity.checks?.filter { $0.status != "pass" }.map(\.detail) ?? []
        return issues.first ?? "All integrity checks passed"
    }
}

struct IntegrityResult: Decodable {
    let verdict: String
    let checks: [IntegrityCheck]?
}

struct IntegrityCheck: Decodable {
    let name: String
    let status: String
    let detail: String
}

enum AuthenticationState: Equatable {
    case checking
    case signedIn
    case signedOut
    case unknown
}

private struct EngineProgressEvent: Decodable {
    let total: Int
    let completed: Int
    let current: Int
    let stage: String
    let message: String
}

struct ExportProgressState {
    let total: Int
    let completed: Int
    let current: Int
    let stage: String
    let message: String

    var fraction: Double {
        guard total > 0 else { return 0 }
        let stageFraction: Double
        switch stage {
        case "preparing": stageFraction = 0.04
        case "reading": stageFraction = 0.14
        case "body": stageFraction = 0.34
        case "tables": stageFraction = 0.48
        case "rendering": stageFraction = 0.52
        case "comments": stageFraction = 0.64
        case "attachments": stageFraction = 0.78
        case "integrity": stageFraction = 0.92
        case "finished", "failed": stageFraction = 0
        default: stageFraction = 0.08
        }
        let inFlight = completed < total ? stageFraction : 0
        return min(1, (Double(completed) + inFlight) / Double(total))
    }

    var counter: String {
        "\(min(max(current, 1), max(total, 1)))/\(max(total, 1))"
    }
}

@MainActor
final class ExportModel: ObservableObject, @unchecked Sendable {
    @Published var urlsText = ""
    @Published var outputBase: URL
    @Published var documents: [ExportDocument] = []
    @Published var logText = ""
    @Published var message = ""
    @Published var isRunning = false
    @Published var isCheckingAuth = false
    @Published var authState: AuthenticationState = .checking
    @Published var showLog = false
    @Published var renderFallback: Bool = UserDefaults.standard.object(forKey: "renderFallback") as? Bool ?? true {
        didSet { UserDefaults.standard.set(renderFallback, forKey: "renderFallback") }
    }
    @Published private(set) var exportProgress: ExportProgressState?

    private var activeProcess: Process?
    private var authProbeProcess: Process?
    private var authPollingTask: Task<Void, Never>?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private var stdoutLineBuffer = ""
    private(set) var currentRunFolder: URL?
    private(set) var currentReportURL: URL?

    init() {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        outputBase = downloads.appendingPathComponent("Feishu Exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: outputBase, withIntermediateDirectories: true)
        Task { [weak self] in
            await self?.checkAuthentication(showFeedback: false)
        }
    }

    var retryCount: Int {
        documents.filter { $0.operationalStatus != "success" || $0.integrity.verdict != "complete" }.count
    }

    var validURLCount: Int {
        parsedURLs().count
    }

    var canOpenOutputFolder: Bool {
        // 目录可能被用户手动删除（例如想重新导出），必须实时校验磁盘，
        // 否则主按钮会卡在「打开文件夹」永远回不到「导出」
        guard let folder = currentRunFolder,
              FileManager.default.fileExists(atPath: folder.path) else { return false }
        return documents.contains { $0.output != nil }
    }

    func chooseOutputFolder() {
        let panel = NSOpenPanel()
        panel.title = "Choose Export Folder"
        panel.prompt = "Choose"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = outputBase
        if panel.runModal() == .OK, let url = panel.url { outputBase = url }
    }

    func login() {
        guard !isRunning else { return }
        authPollingTask?.cancel()
        authState = .checking
        message = "Opening the isolated Chrome for Testing sign-in window…"
        launchNode(script: chromeScript, arguments: ["login"]) { [weak self] code in
            guard let self else { return }
            if code == 0 {
                self.message = "Complete sign-in in Chrome for Testing. The app will confirm it automatically."
                self.beginLoginPolling()
            } else {
                self.authState = .unknown
                self.message = "Could not open the sign-in window. Open Activity Log for details."
            }
        }
    }

    func refreshAuthentication() {
        authPollingTask?.cancel()
        authPollingTask = Task { [weak self] in
            await self?.checkAuthentication(showFeedback: true)
        }
    }

    func export() {
        guard !isRunning else { return }
        let urls = parsedURLs()
        guard !urls.isEmpty else {
            message = "Paste one valid Feishu or Lark document link."
            return
        }
        do {
            let folder = try makeRunFolder(prefix: "Feishu Export")
            var args = urls + ["--out", folder.path]
            if renderFallback { args.append("--render-fallback") }
            startExport(arguments: args, folder: folder, expectedTotal: urls.count)
        } catch {
            message = "Could not create the export folder: \(error.localizedDescription)"
        }
    }

    func retry() {
        guard !isRunning, retryCount > 0, let report = currentReportURL else { return }
        do {
            let folder = try makeRunFolder(prefix: "Feishu Retry")
            var args = ["--retry", report.path, "--out", folder.path]
            if renderFallback { args.append("--render-fallback") }
            startExport(
                arguments: args,
                folder: folder,
                expectedTotal: retryCount
            )
        } catch {
            message = "Could not create the retry folder: \(error.localizedDescription)"
        }
    }

    func cancel() {
        guard let process = activeProcess, process.isRunning else { return }
        message = "Cancelling…"
        process.terminate()
    }

    func openResultPage() {
        guard let folder = currentRunFolder else { return }
        let page = folder.appendingPathComponent("index.html")
        if FileManager.default.fileExists(atPath: page.path) { NSWorkspace.shared.open(page) }
    }

    func openOutputFolder() {
        guard let folder = currentRunFolder else { return }
        NSWorkspace.shared.activateFileViewerSelecting([folder])
    }

    func openOutput(_ document: ExportDocument) {
        guard let output = document.output else { return }
        let url = URL(fileURLWithPath: output)
        if FileManager.default.fileExists(atPath: url.path) { NSWorkspace.shared.open(url) }
    }

    private var resourceRoot: URL {
        Bundle.main.resourceURL!
    }

    private var nodeExecutable: URL {
        resourceRoot.appendingPathComponent("runtime/node")
    }

    private var engineRoot: URL {
        resourceRoot.appendingPathComponent("engine", isDirectory: true)
    }

    private var grabScript: URL {
        engineRoot.appendingPathComponent("grab.mjs")
    }

    private var chromeScript: URL {
        engineRoot.appendingPathComponent("tools/ai-chrome.mjs")
    }

    private func processEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Feishu Grabber", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        environment["AI_CHROME_PROFILE"] = support.appendingPathComponent("Chrome Profile", isDirectory: true).path
        environment["AI_CHROME_PORT"] = "9237"
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
        return environment
    }

    private func parsedURLs() -> [String] {
        let allowed = ["feishu.cn", "larkoffice.com", "larksuite.com"]
        let value = urlsText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty,
              !value.contains(where: { $0.isWhitespace }),
              let url = URL(string: value),
              url.scheme == "https",
              let host = url.host,
              allowed.contains(where: { host == $0 || host.hasSuffix(".\($0)") }) else { return [] }
        return [value]
    }

    private func makeRunFolder(prefix: String) throws -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH-mm-ss"
        let folder = outputBase.appendingPathComponent("\(prefix) \(formatter.string(from: Date()))", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private func startExport(arguments: [String], folder: URL, expectedTotal: Int) {
        currentRunFolder = folder
        currentReportURL = nil
        documents = []
        message = "Exporting in the background…"
        exportProgress = ExportProgressState(
            total: expectedTotal,
            completed: 0,
            current: 1,
            stage: "preparing",
            message: "Preparing export"
        )
        launchNode(script: grabScript, arguments: arguments) { [weak self] code in
            guard let self else { return }
            self.loadReport(from: folder)
            self.exportProgress = nil
            if code == 0 {
                self.message = "Export complete. Every document passed integrity checks."
            } else if code == 2 {
                self.message = "Export complete. Some documents need a retry or manual review."
            } else {
                self.message = "Export failed. Open Activity Log for details."
            }
        }
    }

    private func loadReport(from folder: URL) {
        let reportURL = folder.appendingPathComponent("export-report.json")
        guard let data = try? Data(contentsOf: reportURL),
              let report = try? JSONDecoder().decode(ExportReport.self, from: data) else {
            message = "No valid export-report.json was found."
            return
        }
        currentReportURL = reportURL
        documents = report.documents
    }

    private func beginLoginPolling() {
        authPollingTask?.cancel()
        authPollingTask = Task { [weak self] in
            guard let self else { return }
            self.isCheckingAuth = true
            self.authState = .checking

            for attempt in 0..<60 {
                if Task.isCancelled {
                    self.isCheckingAuth = false
                    return
                }
                if attempt > 0 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
                if Task.isCancelled {
                    self.isCheckingAuth = false
                    return
                }
                let state = await self.probeAuthentication()
                self.authProbeProcess = nil
                if state == .signedIn {
                    self.authState = .signedIn
                    self.isCheckingAuth = false
                    self.message = "Signed in. Paste a document link to start exporting."
                    return
                }
            }

            self.authState = .unknown
            self.isCheckingAuth = false
            self.message = "Sign-in could not be confirmed automatically. Check the account status again."
        }
    }

    private func checkAuthentication(showFeedback: Bool) async {
        guard !isCheckingAuth else { return }
        isCheckingAuth = true
        authState = .checking
        let state = await probeAuthentication()
        authProbeProcess = nil
        authState = state
        isCheckingAuth = false
        if showFeedback {
            switch state {
            case .signedIn:
                message = "Signed in. Paste a document link to start exporting."
            case .signedOut:
                message = "Not signed in to Feishu."
            case .unknown, .checking:
                message = "Sign-in status is temporarily unavailable. Try again shortly."
            }
        }
    }

    private func probeAuthentication() async -> AuthenticationState {
        guard FileManager.default.isExecutableFile(atPath: nodeExecutable.path),
              FileManager.default.fileExists(atPath: chromeScript.path) else {
            return .unknown
        }

        return await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = nodeExecutable
            process.arguments = [chromeScript.path, "auth-status"]
            process.currentDirectoryURL = engineRoot
            process.environment = processEnvironment()
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { task in
                let state: AuthenticationState
                switch task.terminationStatus {
                case 0: state = .signedIn
                case 3: state = .signedOut
                default: state = .unknown
                }
                continuation.resume(returning: state)
            }
            authProbeProcess = process
            do {
                try process.run()
            } catch {
                authProbeProcess = nil
                continuation.resume(returning: .unknown)
            }
        }
    }

    private func consumeStandardOutput(_ text: String, parsesProgress: Bool) {
        guard parsesProgress else {
            logText.append(text)
            return
        }

        stdoutLineBuffer.append(text)
        while let newline = stdoutLineBuffer.firstIndex(of: "\n") {
            let line = String(stdoutLineBuffer[..<newline])
            stdoutLineBuffer.removeSubrange(...newline)
            if !consumeProgressLine(line) {
                logText.append(line)
                logText.append("\n")
            }
        }
    }

    private func consumeProgressLine(_ line: String) -> Bool {
        let prefix = "@@FEISHU_PROGRESS@@"
        guard line.hasPrefix(prefix),
              let data = String(line.dropFirst(prefix.count)).data(using: .utf8),
              let event = try? JSONDecoder().decode(EngineProgressEvent.self, from: data) else {
            return false
        }
        exportProgress = ExportProgressState(
            total: event.total,
            completed: event.completed,
            current: event.current,
            stage: event.stage,
            message: event.message
        )
        message = "Exporting \(exportProgress?.counter ?? "") · \(event.message)"
        return true
    }

    private func launchNode(script: URL, arguments: [String], completion: @escaping (Int32) -> Void) {
        guard FileManager.default.isExecutableFile(atPath: nodeExecutable.path) else {
            message = "The bundled Node.js runtime is missing. Rebuild or reinstall the app."
            return
        }
        guard FileManager.default.fileExists(atPath: script.path) else {
            message = "The export engine is missing. Rebuild or reinstall the app."
            return
        }

        logText = ""
        stdoutLineBuffer = ""
        isRunning = true
        let parsesProgress = script.lastPathComponent == "grab.mjs"
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = nodeExecutable
        process.arguments = [script.path] + arguments
        process.currentDirectoryURL = engineRoot
        process.standardOutput = stdout
        process.standardError = stderr

        var environment = processEnvironment()
        if parsesProgress {
            environment["FEISHU_PROGRESS"] = "1"
        }
        process.environment = environment

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self?.consumeStandardOutput(text, parsesProgress: parsesProgress)
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.logText.append(text) }
        }

        process.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                guard let self else { return }
                stdout.fileHandleForReading.readabilityHandler = nil
                stderr.fileHandleForReading.readabilityHandler = nil
                self.activeProcess = nil
                self.outputPipe = nil
                self.errorPipe = nil
                self.isRunning = false
                completion(task.terminationStatus)
            }
        }

        activeProcess = process
        outputPipe = stdout
        errorPipe = stderr
        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            activeProcess = nil
            outputPipe = nil
            errorPipe = nil
            isRunning = false
            message = "Could not start the export engine: \(error.localizedDescription)"
        }
    }
}

private func statusColor(_ status: String) -> Color {
    switch status {
    case "complete": return .green
    case "degraded": return .orange
    case "incomplete", "failed": return .red
    default: return .secondary
    }
}

private func statusLabel(_ status: String) -> String {
    switch status {
    case "complete": return "Complete"
    case "degraded": return "Degraded"
    case "incomplete": return "Incomplete"
    case "failed": return "Failed"
    default: return status
    }
}

private enum AppearanceMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

private enum AppPage {
    case main
    case settings
}

private struct HoverSurface: ViewModifier {
    let cornerRadius: CGFloat
    @State private var isHovering = false

    func body(content: Content) -> some View {
        content
            .background(
                isHovering ? Color(nsColor: .controlBackgroundColor) : .clear,
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .onHover { isHovering = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovering)
    }
}

private extension View {
    func hoverSurface(cornerRadius: CGFloat = 8) -> some View {
        modifier(HoverSurface(cornerRadius: cornerRadius))
    }
}

private struct PrimaryActionButton: View {
    let title: String
    let isWorking: Bool
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Group {
                if isWorking {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                        .accessibilityLabel("Exporting")
                } else {
                    Text(title)
                        .font(.system(size: 14, weight: .semibold))
                }
            }
            .frame(minWidth: 88)
            .frame(height: 52)
            .padding(.horizontal, title == "Open Folder" ? 4 : 0)
            .foregroundStyle(.white)
            .background(
                Color.accentColor.opacity(isHovering && !isWorking ? 0.9 : 1),
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .shadow(color: Color.accentColor.opacity(isHovering ? 0.24 : 0.12), radius: isHovering ? 7 : 2, y: isHovering ? 3 : 1)
            .scaleEffect(!reduceMotion && isHovering && !isWorking ? 1.01 : 1)
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
    }
}

struct ContentView: View {
    private let titlebarInset: CGFloat = 33

    @StateObject private var model = ExportModel()
    @AppStorage("appearanceMode") private var appearanceRawValue = AppearanceMode.system.rawValue
    @State private var page: AppPage = .main
    @State private var submittedURL = ""
    @FocusState private var urlFieldFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var appearance: AppearanceMode {
        AppearanceMode(rawValue: appearanceRawValue) ?? .system
    }

    private var appearanceSelection: Binding<AppearanceMode> {
        Binding(
            get: { appearance },
            set: { appearanceRawValue = $0.rawValue }
        )
    }

    private var currentInput: String {
        model.urlsText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canOpenCurrentFolder: Bool {
        !submittedURL.isEmpty && currentInput == submittedURL && model.canOpenOutputFolder && !model.isRunning
    }

    private var completionSummary: (text: String, color: Color)? {
        guard !model.documents.isEmpty, currentInput == submittedURL else { return nil }
        if model.documents.contains(where: { $0.operationalStatus != "success" }) {
            return ("Export failed", .red)
        }
        if model.documents.contains(where: { $0.integrity.verdict == "incomplete" }) {
            return ("Exported with missing content", .orange)
        }
        if model.documents.allSatisfy({ $0.integrity.verdict == "complete" }) {
            return ("Exported", .green)
        }
        // degraded：资源全部导出，但存在视觉兜底（如画板截图），结构完整性无法证明
        return ("Exported with visual fallbacks", .orange)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                header
                Divider()
                ZStack {
                    if page == .main {
                        mainScreen
                            .transition(screenTransition(edge: .leading))
                    } else {
                        settingsScreen
                            .transition(screenTransition(edge: .trailing))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                VStack(spacing: 0) {
                    Divider()
                    logBar
                }
                // The header draws into the hidden macOS titlebar. Move the footer by
                // the same reserved inset so the window does not retain a blank chin.
                .offset(y: titlebarInset)
            }

            if model.showLog {
                logDrawer
                    .padding(.horizontal, 16)
                    .padding(.bottom, 52 - titlebarInset)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    .zIndex(4)
            }
        }
        .frame(width: 920, height: 507)
        .ignoresSafeArea(.container, edges: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        .preferredColorScheme(appearance.colorScheme)
        .animation(.easeOut(duration: 0.2), value: page)
        .animation(.easeOut(duration: 0.18), value: model.showLog)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                urlFieldFocused = true
            }
        }
        .onChange(of: model.urlsText) { newValue in
            guard !model.isRunning, newValue.trimmingCharacters(in: .whitespacesAndNewlines) != submittedURL else { return }
            model.message = ""
        }
    }

    private func screenTransition(edge: Edge) -> AnyTransition {
        reduceMotion ? .opacity : .move(edge: edge).combined(with: .opacity)
    }

    private var header: some View {
        ZStack {
            HStack {
                Spacer()
                if page == .main {
                    Button {
                        urlFieldFocused = false
                        withAnimation {
                            model.showLog = false
                            page = .settings
                        }
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.system(size: 14, weight: .medium))
                            .frame(width: 34, height: 34)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverSurface(cornerRadius: 9)
                    .help("Settings")
                }
            }

            HStack(spacing: 10) {
                Image(nsImage: NSApplication.shared.applicationIconImage)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                Text("Feishu Grabber")
                    .font(.system(size: 15, weight: .semibold))
            }
        }
        .frame(height: 50)
        .padding(.horizontal, 24)
    }

    private var mainScreen: some View {
        VStack {
            Spacer()
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    HStack(spacing: 10) {
                        Image(systemName: "link")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                        TextField(
                            "",
                            text: $model.urlsText,
                            prompt: Text("Paste a Feishu or Lark document link")
                                .font(.system(size: 14))
                                .foregroundColor(Color(nsColor: .placeholderTextColor))
                        )
                            .textFieldStyle(.plain)
                            .font(.system(size: 14, design: .monospaced))
                            .focused($urlFieldFocused)
                            .disabled(model.isRunning)
                            .onSubmit { performPrimaryAction() }
                            .accessibilityLabel("Feishu or Lark document link")
                    }
                    .padding(.horizontal, 15)
                    .frame(height: 52)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(urlFieldFocused ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: urlFieldFocused ? 1.5 : 1)
                    )
                    .shadow(color: .black.opacity(0.04), radius: 2, y: 1)

                    PrimaryActionButton(
                        title: canOpenCurrentFolder ? "Open Folder" : "Export",
                        isWorking: model.isRunning,
                        action: performPrimaryAction
                    )
                }

                statusAndProgress
            }
            .frame(maxWidth: 720)
            .offset(y: -8)
            Spacer()
        }
        .padding(.horizontal, 64)
    }

    @ViewBuilder
    private var statusAndProgress: some View {
        if model.isRunning {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 7, height: 7)
                    Text(model.exportProgress?.message ?? "Preparing export")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                }
                GeometryReader { geometry in
                    let fraction = model.exportProgress?.fraction ?? 0.03
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.accentColor.opacity(0.14))
                        Capsule()
                            .fill(Color.accentColor)
                            .frame(width: max(3, geometry.size.width * fraction))
                    }
                    .animation(.easeOut(duration: 0.32), value: fraction)
                }
                .frame(height: 3)
                    .accessibilityLabel("Export progress")
                    .accessibilityValue(model.exportProgress.map { "\($0.counter), \($0.message)" } ?? "Preparing export")
            }
            .padding(.top, 12)
            .padding(.horizontal, 3)
        } else if let completionSummary {
            HStack(spacing: 8) {
                Circle().fill(completionSummary.color).frame(width: 7, height: 7)
                Text(completionSummary.text)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 12)
            .padding(.horizontal, 3)
        } else if !model.message.isEmpty {
            HStack(spacing: 8) {
                Circle().fill(Color.red).frame(width: 7, height: 7)
                Text(model.message)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.top, 12)
            .padding(.horizontal, 3)
        }
    }

    private var settingsScreen: some View {
        VStack(spacing: 20) {
            ZStack {
                HStack {
                    Button {
                        withAnimation { page = .main }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                            urlFieldFocused = true
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "chevron.left")
                            Text("Back")
                        }
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .frame(height: 32)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverSurface()
                    Spacer()
                }
                Text("Settings")
                    .font(.system(size: 18, weight: .semibold))
            }
            .frame(maxWidth: 700)

            VStack(spacing: 0) {
                HStack(spacing: 24) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Save Location").font(.system(size: 13.5, weight: .medium))
                        Text((model.outputBase.path as NSString).abbreviatingWithTildeInPath)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    Button("Change") { model.chooseOutputFolder() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(model.isRunning)
                }
                .padding(.horizontal, 16)
                .frame(height: 72)

                Divider()

                HStack(spacing: 24) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Appearance").font(.system(size: 13.5, weight: .medium))
                        Text("Follow the system or use a fixed appearance")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Picker("Appearance", selection: appearanceSelection) {
                        ForEach(AppearanceMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .frame(width: 150)
                }
                .padding(.horizontal, 16)
                .frame(height: 72)

                Divider()

                HStack(spacing: 24) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Render Fallback").font(.system(size: 13.5, weight: .medium))
                        Text("Export whiteboard and table screenshots; may briefly bring Chrome forward")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Toggle("", isOn: $model.renderFallback)
                        .labelsHidden()
                        .disabled(model.isRunning)
                }
                .padding(.horizontal, 16)
                .frame(height: 72)

                Divider()

                HStack(spacing: 24) {
                    HStack(spacing: 10) {
                        Group {
                            if model.authState == .checking {
                                ProgressView().controlSize(.mini)
                            } else {
                                Circle()
                                    .fill(accountStatusColor)
                                    .frame(width: 8, height: 8)
                            }
                        }
                        .frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Feishu Account").font(.system(size: 13.5, weight: .medium))
                            Text(accountStatusText)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button(model.authState == .signedIn ? "Sign In Again" : "Sign In") { model.login() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(model.isRunning || model.isCheckingAuth)
                }
                .padding(.horizontal, 16)
                .frame(height: 72)
            }
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
            )
            .frame(maxWidth: 700)

            Spacer()
        }
        .padding(.top, 28)
        .padding(.horizontal, 64)
        .padding(.bottom, 44)
    }

    private var accountStatusText: String {
        switch model.authState {
        case .signedIn: return "Signed In"
        case .signedOut: return "Not Signed In"
        case .checking: return "Checking"
        case .unknown: return "Status Unavailable"
        }
    }

    private var accountStatusColor: Color {
        switch model.authState {
        case .signedIn: return .green
        case .signedOut: return .red
        case .checking, .unknown: return .secondary
        }
    }

    private var logBar: some View {
        HStack {
            Button {
                withAnimation { model.showLog.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: model.showLog ? "chevron.up" : "chevron.right")
                    Image(systemName: "terminal")
                    Text("Activity Log")
                }
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .frame(height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverSurface(cornerRadius: 7)
            Spacer()
        }
        .padding(.horizontal, 17)
        .frame(height: 46)
    }

    private var logDrawer: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Activity Log")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Button {
                    withAnimation { model.showLog = false }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .medium))
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverSurface(cornerRadius: 7)
                .help("Close Activity Log")
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .frame(height: 42)

            Divider()

            ScrollView {
                Text(model.logText.isEmpty ? "Waiting for an export…" : model.logText)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
        }
        .frame(height: 220)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.2), radius: 24, y: 10)
    }

    private func performPrimaryAction() {
        if canOpenCurrentFolder {
            model.openOutputFolder()
            return
        }
        submittedURL = currentInput
        model.export()
    }
}

@main
struct FeishuGrabberApp: App {
    init() {
        if CommandLine.arguments.contains("--resource-smoke-test") {
            let root = Bundle.main.resourceURL!
            let required = ["runtime/node", "engine/grab.mjs", "engine/tools/ai-chrome.mjs", "engine/node_modules"]
            let missing = required.filter { !FileManager.default.fileExists(atPath: root.appendingPathComponent($0).path) }
            if missing.isEmpty {
                print("RESOURCE_BUNDLE_OK")
                Foundation.exit(0)
            }
            fputs("Missing resources: \(missing.joined(separator: ", "))\n", stderr)
            Foundation.exit(2)
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 920, height: 507)
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(replacing: .newItem) { }
        }
    }
}

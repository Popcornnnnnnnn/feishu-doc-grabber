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
        return issues.first ?? "所有完整性检查通过"
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
    @Published var message = "粘贴飞书文档链接即可开始"
    @Published var isRunning = false
    @Published var isCheckingAuth = false
    @Published var authState: AuthenticationState = .checking
    @Published var showLog = false
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

    func chooseOutputFolder() {
        let panel = NSOpenPanel()
        panel.title = "Choose export folder"
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
        message = "正在打开隔离的 Chrome for Testing 登录窗口…"
        launchNode(script: chromeScript, arguments: ["login"]) { [weak self] code in
            guard let self else { return }
            if code == 0 {
                self.message = "请在 Chrome for Testing 中完成登录，完成后会自动确认"
                self.beginLoginPolling()
            } else {
                self.authState = .unknown
                self.message = "登录窗口启动失败，请展开运行日志查看原因"
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
            message = "请至少粘贴一个有效的飞书或 Lark 文档链接"
            return
        }
        do {
            let folder = try makeRunFolder(prefix: "Feishu Export")
            startExport(arguments: urls + ["--out", folder.path], folder: folder, expectedTotal: urls.count)
        } catch {
            message = "无法创建输出目录：\(error.localizedDescription)"
        }
    }

    func retry() {
        guard !isRunning, retryCount > 0, let report = currentReportURL else { return }
        do {
            let folder = try makeRunFolder(prefix: "Feishu Retry")
            startExport(
                arguments: ["--retry", report.path, "--out", folder.path],
                folder: folder,
                expectedTotal: retryCount
            )
        } catch {
            message = "无法创建重试目录：\(error.localizedDescription)"
        }
    }

    func cancel() {
        guard let process = activeProcess, process.isRunning else { return }
        message = "正在取消…"
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
        let values = urlsText.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
        var seen = Set<String>()
        return values.filter { value in
            guard let url = URL(string: value), url.scheme == "https", let host = url.host else { return false }
            guard allowed.contains(where: { host == $0 || host.hasSuffix(".\($0)") }) else { return false }
            return seen.insert(value).inserted
        }
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
        message = "正在后台导出…"
        exportProgress = ExportProgressState(
            total: expectedTotal,
            completed: 0,
            current: 1,
            stage: "preparing",
            message: "准备导出"
        )
        launchNode(script: grabScript, arguments: arguments) { [weak self] code in
            guard let self else { return }
            self.loadReport(from: folder)
            self.exportProgress = nil
            if code == 0 {
                self.message = "导出完成，所有文档均为 complete"
            } else if code == 2 {
                self.message = "导出完成，但有文档需要重试或人工查看"
            } else {
                self.message = "导出失败，请查看结果和运行日志"
            }
        }
    }

    private func loadReport(from folder: URL) {
        let reportURL = folder.appendingPathComponent("export-report.json")
        guard let data = try? Data(contentsOf: reportURL),
              let report = try? JSONDecoder().decode(ExportReport.self, from: data) else {
            message = "没有读取到有效的 export-report.json"
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
                    self.message = "登录成功，可以粘贴文档链接开始导出"
                    return
                }
            }

            self.authState = .unknown
            self.isCheckingAuth = false
            self.message = "没有自动确认登录状态，可点击状态标签重新检测"
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
                message = "已登录，可以粘贴文档链接开始导出"
            case .signedOut:
                message = "尚未登录飞书"
            case .unknown, .checking:
                message = "暂时无法确认登录状态，请稍后重试"
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
        message = "正在导出 \(exportProgress?.counter ?? "") · \(event.message)"
        return true
    }

    private func launchNode(script: URL, arguments: [String], completion: @escaping (Int32) -> Void) {
        guard FileManager.default.isExecutableFile(atPath: nodeExecutable.path) else {
            message = "App 内缺少 Node 运行时，请重新构建或安装"
            return
        }
        guard FileManager.default.fileExists(atPath: script.path) else {
            message = "App 内缺少导出引擎，请重新构建或安装"
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
            message = "无法启动导出引擎：\(error.localizedDescription)"
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
    case "complete": return "完整"
    case "degraded": return "降级"
    case "incomplete": return "不完整"
    case "failed": return "失败"
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
        case .system: return "系统"
        case .light: return "浅色"
        case .dark: return "深色"
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

private struct StatusCount: View {
    let value: Int
    let title: String
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(title).foregroundStyle(.secondary)
            Text("\(value)").fontWeight(.semibold)
        }
        .font(.caption)
    }
}

private struct DocumentRow: View {
    let document: ExportDocument
    let open: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: document.status == "complete" ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(statusColor(document.status))
                .font(.system(size: 16))
            VStack(alignment: .leading, spacing: 3) {
                Text(document.displayName)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                Text(document.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Text(statusLabel(document.status))
                .font(.caption)
                .foregroundStyle(statusColor(document.status))
            if document.output != nil {
                Button(action: open) {
                    Image(systemName: "arrow.up.right")
                }
                .buttonStyle(.borderless)
                .help("打开导出文件")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

private final class PlaceholderTextView: NSTextView {
    var placeholder = "" {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        guard string.isEmpty, !placeholder.isEmpty, let font else { return }
        (placeholder as NSString).draw(
            at: textContainerOrigin,
            withAttributes: [
                .font: font,
                .foregroundColor: NSColor.placeholderTextColor
            ]
        )
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

private struct LinkTextEditor: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

        let textView = PlaceholderTextView(frame: .zero)
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.drawsBackground = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textColor = .labelColor
        textView.insertionPointColor = .controlAccentColor
        textView.textContainerInset = NSSize(width: 12, height: 12)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.placeholder = placeholder
        textView.string = text

        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? PlaceholderTextView else { return }
        context.coordinator.parent = self
        if textView.string != text {
            textView.string = text
        }
        textView.placeholder = placeholder
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textColor = .labelColor
        textView.insertionPointColor = .controlAccentColor
        textView.needsDisplay = true
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: LinkTextEditor

        init(parent: LinkTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

struct ExportProgressView: View {
    let progress: ExportProgressState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("正在导出 \(progress.counter)")
                    .font(.caption.weight(.medium))
                Text(progress.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: progress.fraction)
                .progressViewStyle(.linear)
                .controlSize(.small)
                .accessibilityLabel("导出进度")
                .accessibilityValue("\(progress.counter)，\(progress.message)")
        }
        .frame(maxWidth: 360)
    }
}

struct ContentView: View {
    @StateObject private var model = ExportModel()
    @AppStorage("appearanceMode") private var appearanceRawValue = AppearanceMode.system.rawValue

    private var appearance: AppearanceMode {
        AppearanceMode(rawValue: appearanceRawValue) ?? .system
    }

    private var appearanceSelection: Binding<AppearanceMode> {
        Binding(
            get: { appearance },
            set: { appearanceRawValue = $0.rawValue }
        )
    }

    private var counts: [String: Int] {
        Dictionary(grouping: model.documents, by: \.status).mapValues(\.count)
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    exportSection
                    if !model.documents.isEmpty {
                        resultsSection
                    }
                }
                .frame(maxWidth: 760)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            Divider()
            logSection
        }
        .frame(minWidth: 680, minHeight: 460)
        .background(Color(nsColor: .windowBackgroundColor))
        .preferredColorScheme(appearance.colorScheme)
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .scaledToFit()
                .frame(width: 30, height: 30)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            Text("Feishu Grabber")
                .font(.headline)
            Spacer()
            Picker("外观", selection: appearanceSelection) {
                ForEach(AppearanceMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 156)
            .help("切换界面外观")
            accountControl
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 12)
    }

    @ViewBuilder
    private var accountControl: some View {
        switch model.authState {
        case .signedIn:
            Menu {
                Button("检测登录状态") { model.refreshAuthentication() }
                Divider()
                Button("重新登录") { model.login() }
            } label: {
                Label("已登录", systemImage: "checkmark.circle.fill")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        case .checking:
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("检测登录")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(width: 78)
        case .signedOut, .unknown:
            Button { model.login() } label: {
                Label("登录飞书", systemImage: "person.crop.circle")
            }
            .disabled(model.isRunning || model.isCheckingAuth)
        }
    }

    private var exportSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("导出文档")
                        .font(.title3.weight(.semibold))
                    Spacer()
                    if model.validURLCount > 0 {
                        Text("\(model.validURLCount) 个链接")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Text("粘贴一个或多个飞书 / Lark 文档链接，每行一个。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            LinkTextEditor(
                text: $model.urlsText,
                placeholder: "https://example.feishu.cn/wiki/…"
            )
            .frame(height: 138)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
            )

            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("保存位置")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(model.outputBase.path)
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                Spacer()
                Button("更改…") { model.chooseOutputFolder() }
                    .disabled(model.isRunning)
            }
            .padding(11)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 12) {
                if model.isRunning, let progress = model.exportProgress {
                    ExportProgressView(progress: progress)
                } else {
                    Image(systemName: model.authState == .signedIn ? "checkmark.circle" : "info.circle")
                        .foregroundStyle(.secondary)
                    Text(model.message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if model.isRunning {
                    Button("取消", role: .destructive) { model.cancel() }
                }
                Button(model.isRunning ? "正在导出…" : "开始导出") {
                    model.export()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .disabled(model.isRunning || model.validURLCount == 0)
            }

            Text("正文、表格、评论和附件会随完整性报告一起导出。")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private var resultsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack {
                Text("导出结果")
                    .font(.headline)
                Spacer()
                Button("结果页") { model.openResultPage() }
                Button("在 Finder 中显示") { model.openOutputFolder() }
            }
            HStack(spacing: 16) {
                StatusCount(value: counts["complete", default: 0], title: "完整", color: .green)
                StatusCount(value: counts["degraded", default: 0], title: "降级", color: .orange)
                StatusCount(value: counts["incomplete", default: 0], title: "不完整", color: .red)
                StatusCount(value: counts["failed", default: 0], title: "失败", color: .red)
                Spacer()
                if model.retryCount > 0 {
                    Button("重试未完成项") { model.retry() }
                        .disabled(model.isRunning)
                }
            }
            VStack(spacing: 0) {
                ForEach(model.documents) { document in
                    DocumentRow(document: document) { model.openOutput(document) }
                    if document.id != model.documents.last?.id {
                        Divider().padding(.leading, 40)
                    }
                }
            }
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
            )
        }
    }

    private var logSection: some View {
        DisclosureGroup(isExpanded: $model.showLog) {
            ScrollView {
                Text(model.logText.isEmpty ? "暂无运行日志。" : model.logText)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(maxHeight: 130)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
            .padding(.top, 8)
        } label: {
            Label("运行日志", systemImage: "terminal")
                .font(.caption)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
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
        .defaultSize(width: 760, height: 520)
        .commands {
            CommandGroup(replacing: .newItem) { }
        }
    }
}

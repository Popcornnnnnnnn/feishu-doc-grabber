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

    private var activeProcess: Process?
    private var authProbeProcess: Process?
    private var authPollingTask: Task<Void, Never>?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
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
        message = "正在打开隔离的 Chrome 登录窗口…"
        launchNode(script: chromeScript, arguments: ["login"]) { [weak self] code in
            guard let self else { return }
            if code == 0 {
                self.message = "请在 Chrome 中完成登录，完成后会自动确认"
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
            startExport(arguments: urls + ["--out", folder.path], folder: folder)
        } catch {
            message = "无法创建输出目录：\(error.localizedDescription)"
        }
    }

    func retry() {
        guard !isRunning, retryCount > 0, let report = currentReportURL else { return }
        do {
            let folder = try makeRunFolder(prefix: "Feishu Retry")
            startExport(arguments: ["--retry", report.path, "--out", folder.path], folder: folder)
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

    private func startExport(arguments: [String], folder: URL) {
        currentRunFolder = folder
        currentReportURL = nil
        documents = []
        message = "正在后台导出…"
        launchNode(script: grabScript, arguments: arguments) { [weak self] code in
            guard let self else { return }
            self.loadReport(from: folder)
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
        isRunning = true
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = nodeExecutable
        process.arguments = [script.path] + arguments
        process.currentDirectoryURL = engineRoot
        process.standardOutput = stdout
        process.standardError = stderr

        process.environment = processEnvironment()

        let consume: @Sendable (FileHandle) -> Void = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.logText.append(text) }
        }
        stdout.fileHandleForReading.readabilityHandler = consume
        stderr.fileHandleForReading.readabilityHandler = consume

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
    case "complete": return AppTheme.success
    case "degraded": return AppTheme.warning
    case "incomplete", "failed": return AppTheme.danger
    default: return AppTheme.mutedText
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

private enum AppTheme {
    static let canvas = Color(red: 0.035, green: 0.043, blue: 0.071)
    static let panel = Color(red: 0.067, green: 0.078, blue: 0.118)
    static let elevated = Color(red: 0.09, green: 0.104, blue: 0.153)
    static let field = Color(red: 0.047, green: 0.055, blue: 0.086)
    static let stroke = Color.white.opacity(0.09)
    static let strongStroke = Color.white.opacity(0.16)
    static let primaryText = Color.white.opacity(0.96)
    static let secondaryText = Color.white.opacity(0.62)
    static let mutedText = Color.white.opacity(0.42)
    static let accent = Color(red: 0.47, green: 0.39, blue: 1.0)
    static let cyan = Color(red: 0.12, green: 0.76, blue: 0.92)
    static let success = Color(red: 0.27, green: 0.86, blue: 0.58)
    static let warning = Color(red: 1.0, green: 0.68, blue: 0.24)
    static let danger = Color(red: 1.0, green: 0.35, blue: 0.43)
}

struct PrimaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 20)
            .frame(height: 42)
            .background(
                LinearGradient(
                    colors: [AppTheme.accent, AppTheme.cyan],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
            )
            .shadow(color: AppTheme.accent.opacity(0.24), radius: 14, y: 7)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct SecondaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(AppTheme.primaryText)
            .padding(.horizontal, 14)
            .frame(height: 36)
            .background(AppTheme.elevated, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(AppTheme.stroke, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

struct FeatureBadge: View {
    let icon: String
    let title: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: icon).foregroundStyle(AppTheme.cyan)
            Text(title).foregroundStyle(AppTheme.secondaryText)
        }
        .font(.system(size: 12, weight: .medium))
        .padding(.horizontal, 11)
        .frame(height: 30)
        .background(AppTheme.elevated.opacity(0.72), in: Capsule())
        .overlay(Capsule().stroke(AppTheme.stroke, lineWidth: 1))
    }
}

struct MetricView: View {
    let value: Int
    let title: String
    let color: Color
    let icon: String

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 30, height: 30)
                .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text("\(value)").font(.system(size: 19, weight: .bold)).foregroundStyle(AppTheme.primaryText)
                Text(title).font(.caption).foregroundStyle(AppTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(AppTheme.elevated.opacity(0.72), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(AppTheme.stroke, lineWidth: 1))
    }
}

struct DocumentRow: View {
    let document: ExportDocument
    let open: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 13) {
            Image(systemName: document.status == "complete" ? "checkmark" : "exclamationmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(statusColor(document.status))
                .frame(width: 28, height: 28)
                .background(statusColor(document.status).opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 5) {
                Text(document.displayName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.primaryText)
                    .lineLimit(1)
                Text(document.detail)
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
                    .lineLimit(2)
            }
            Spacer()
            Text(statusLabel(document.status))
                .font(.caption.weight(.semibold)).foregroundStyle(statusColor(document.status))
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(statusColor(document.status).opacity(0.12), in: Capsule())
            if document.output != nil {
                Button(action: open) {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.secondaryText)
                        .frame(width: 28, height: 28)
                        .background(AppTheme.elevated, in: RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
                .help("打开导出文件")
            }
        }
        .padding(13)
        .background(AppTheme.field, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.stroke, lineWidth: 1))
    }
}

struct ContentView: View {
    @StateObject private var model = ExportModel()

    private var counts: [String: Int] {
        Dictionary(grouping: model.documents, by: \.status).mapValues(\.count)
    }

    private var accountStatusTitle: String {
        if model.isRunning { return "正在运行" }
        switch model.authState {
        case .checking: return "检测登录"
        case .signedIn: return "已登录"
        case .signedOut: return "未登录"
        case .unknown: return "待确认"
        }
    }

    private var accountStatusColor: Color {
        if model.isRunning { return AppTheme.cyan }
        switch model.authState {
        case .checking: return AppTheme.cyan
        case .signedIn: return AppTheme.success
        case .signedOut: return AppTheme.warning
        case .unknown: return AppTheme.mutedText
        }
    }

    var body: some View {
        ZStack {
            AppTheme.canvas.ignoresSafeArea()
            RadialGradient(
                colors: [AppTheme.accent.opacity(0.12), .clear],
                center: .topLeading,
                startRadius: 10,
                endRadius: 520
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                header
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        hero
                        inputSection
                        if model.documents.isEmpty {
                            capabilitySection
                        } else {
                            resultsSection
                        }
                        logSection
                    }
                    .frame(maxWidth: 920)
                    .padding(.horizontal, 34)
                    .padding(.top, 30)
                    .padding(.bottom, 28)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .frame(minWidth: 820, minHeight: 650)
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .scaledToFit()
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Feishu Grabber")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(AppTheme.primaryText)
                Text("本地完整性导出")
                    .font(.caption)
                    .foregroundStyle(AppTheme.mutedText)
            }
            Spacer()
            Button { model.refreshAuthentication() } label: {
                HStack(spacing: 7) {
                    if model.isRunning || model.isCheckingAuth {
                        ProgressView().controlSize(.mini).tint(accountStatusColor)
                    } else {
                        Circle().fill(accountStatusColor).frame(width: 6, height: 6)
                    }
                    Text(accountStatusTitle)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(AppTheme.secondaryText)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(AppTheme.elevated.opacity(0.74), in: Capsule())
                .overlay(Capsule().stroke(AppTheme.stroke, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(model.isRunning || model.isCheckingAuth)
            .help("重新检测登录状态")
            Button { model.login() } label: {
                Label(
                    model.authState == .signedIn ? "重新登录" : "登录飞书",
                    systemImage: model.authState == .signedIn ? "person.crop.circle.badge.checkmark" : "person.crop.circle"
                )
            }
            .buttonStyle(SecondaryActionButtonStyle())
            .disabled(model.isRunning || model.isCheckingAuth)
        }
        .padding(.horizontal, 24)
        .padding(.top, 18)
        .padding(.bottom, 13)
        .background(AppTheme.canvas.opacity(0.9))
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.stroke).frame(height: 1) }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("把飞书文档，完整带回本地。")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.primaryText)
            Text("批量导出正文、表格、评论和附件，并明确告诉你哪些内容完整、哪些还需要处理。")
                .font(.system(size: 14))
                .foregroundStyle(AppTheme.secondaryText)
        }
    }

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center) {
                Text("01")
                    .font(.caption2.bold())
                    .foregroundStyle(AppTheme.cyan)
                    .frame(width: 28, height: 22)
                    .background(AppTheme.cyan.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                Text("添加文档")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.primaryText)
                Spacer()
                if model.validURLCount > 0 {
                    Text("已识别 \(model.validURLCount) 个链接")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppTheme.success)
                }
            }

            ZStack(alignment: .topLeading) {
                TextEditor(text: $model.urlsText)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(AppTheme.primaryText)
                    .scrollContentBackground(.hidden)
                    .padding(11)
                if model.urlsText.isEmpty {
                    Text("粘贴一个或多个飞书 / Lark 文档链接…")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(AppTheme.mutedText)
                        .padding(.leading, 16)
                        .padding(.top, 18)
                        .allowsHitTesting(false)
                }
            }
            .frame(height: 132)
            .background(AppTheme.field, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(model.validURLCount > 0 ? AppTheme.cyan.opacity(0.48) : AppTheme.strongStroke, lineWidth: 1)
            )

            HStack {
                Image(systemName: "externaldrive.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(AppTheme.cyan)
                    .frame(width: 30, height: 30)
                    .background(AppTheme.cyan.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text("保存位置").font(.caption2).foregroundStyle(AppTheme.mutedText)
                    Text(model.outputBase.path)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                        .textSelection(.enabled)
                }
                Spacer()
                Button("更改") { model.chooseOutputFolder() }
                    .buttonStyle(SecondaryActionButtonStyle())
                    .disabled(model.isRunning)
            }

            HStack {
                if model.isRunning {
                    Button("取消导出", role: .destructive) { model.cancel() }
                        .buttonStyle(.plain)
                        .foregroundStyle(AppTheme.danger)
                } else {
                    HStack(spacing: 7) {
                        Image(systemName: "info.circle")
                        Text(model.message).lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(AppTheme.mutedText)
                }
                Spacer()
                Button {
                    model.export()
                } label: {
                    Label(
                        model.isRunning ? "正在导出…" : (model.validURLCount > 1 ? "导出 \(model.validURLCount) 个文档" : "开始导出"),
                        systemImage: "arrow.down.doc.fill"
                    )
                }
                .buttonStyle(PrimaryActionButtonStyle())
                .disabled(model.isRunning || model.validURLCount == 0)
                .opacity(model.isRunning || model.validURLCount == 0 ? 0.42 : 1)
            }
        }
        .padding(20)
        .background(AppTheme.panel.opacity(0.94), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(AppTheme.stroke, lineWidth: 1))
        .shadow(color: .black.opacity(0.2), radius: 28, y: 16)
    }

    private var capabilitySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("关键结构，都有明确检查")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(AppTheme.secondaryText)
            HStack(spacing: 8) {
                FeatureBadge(icon: "text.alignleft", title: "富文本")
                FeatureBadge(icon: "tablecells", title: "表格")
                FeatureBadge(icon: "bubble.left.and.bubble.right", title: "评论")
                FeatureBadge(icon: "paperclip", title: "附件")
                FeatureBadge(icon: "checkmark.shield", title: "完整性报告")
            }
            HStack(spacing: 9) {
                Image(systemName: "moon.zzz.fill").foregroundStyle(AppTheme.accent)
                Text("普通导出使用隔离浏览器配置在后台运行；只有首次登录会打开 Chrome。")
                    .font(.caption)
                    .foregroundStyle(AppTheme.mutedText)
            }
            .padding(.top, 2)
        }
    }

    private var resultsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("导出结果").font(.system(size: 16, weight: .semibold)).foregroundStyle(AppTheme.primaryText)
                    Text(model.message).font(.caption).foregroundStyle(AppTheme.secondaryText)
                }
                Spacer()
                Button { model.openResultPage() } label: { Label("结果页", systemImage: "safari") }
                    .buttonStyle(SecondaryActionButtonStyle())
                Button { model.openOutputFolder() } label: { Label("在 Finder 中显示", systemImage: "folder") }
                    .buttonStyle(SecondaryActionButtonStyle())
            }
            HStack(spacing: 10) {
                MetricView(value: counts["complete", default: 0], title: "完整", color: AppTheme.success, icon: "checkmark")
                MetricView(value: counts["degraded", default: 0], title: "降级", color: AppTheme.warning, icon: "minus")
                MetricView(value: counts["incomplete", default: 0], title: "不完整", color: AppTheme.danger, icon: "exclamationmark")
                MetricView(value: counts["failed", default: 0], title: "失败", color: AppTheme.danger, icon: "xmark")
            }
            ForEach(model.documents) { document in
                DocumentRow(document: document) { model.openOutput(document) }
            }
            if model.retryCount > 0 {
                HStack {
                    Text("有 \(model.retryCount) 个文档尚未达到完整状态")
                        .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    Spacer()
                    Button { model.retry() } label: { Label("重试未完成项", systemImage: "arrow.clockwise") }
                        .buttonStyle(PrimaryActionButtonStyle())
                        .disabled(model.isRunning)
                }
                .padding(.top, 4)
            }
        }
        .padding(20)
        .background(AppTheme.panel.opacity(0.94), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(AppTheme.stroke, lineWidth: 1))
    }

    private var logSection: some View {
        DisclosureGroup(isExpanded: $model.showLog) {
            ScrollView {
                Text(model.logText.isEmpty ? "暂无运行日志。" : model.logText)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(maxHeight: 180)
            .background(Color.black.opacity(0.34), in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(AppTheme.secondaryText)
            .padding(.top, 8)
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "terminal")
                Text("运行日志")
                if !model.logText.isEmpty {
                    Circle().fill(AppTheme.cyan).frame(width: 5, height: 5)
                }
            }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(AppTheme.mutedText)
        .tint(AppTheme.mutedText)
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
        .defaultSize(width: 960, height: 680)
        .commands {
            CommandGroup(replacing: .newItem) { }
        }
    }
}

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

@MainActor
final class ExportModel: ObservableObject, @unchecked Sendable {
    @Published var urlsText = ""
    @Published var outputBase: URL
    @Published var documents: [ExportDocument] = []
    @Published var logText = ""
    @Published var message = "粘贴飞书文档链接即可开始"
    @Published var isRunning = false
    @Published var showLog = false

    private var activeProcess: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private(set) var currentRunFolder: URL?
    private(set) var currentReportURL: URL?

    init() {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        outputBase = downloads.appendingPathComponent("Feishu Exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: outputBase, withIntermediateDirectories: true)
    }

    var retryCount: Int {
        documents.filter { $0.operationalStatus != "success" || $0.integrity.verdict != "complete" }.count
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
        message = "正在打开隔离的 Chrome 登录窗口…"
        launchNode(script: chromeScript, arguments: ["login"]) { [weak self] code in
            guard let self else { return }
            self.message = code == 0
                ? "请在 Chrome 中完成登录；登录后可直接返回这里导出"
                : "登录窗口启动失败，请展开运行日志查看原因"
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

        var environment = ProcessInfo.processInfo.environment
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Feishu Grabber", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        environment["AI_CHROME_PROFILE"] = support.appendingPathComponent("Chrome Profile", isDirectory: true).path
        environment["AI_CHROME_PORT"] = "9237"
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
        process.environment = environment

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
    case "complete": return .green
    case "degraded": return .orange
    case "incomplete", "failed": return .red
    default: return .secondary
    }
}

struct MetricView: View {
    let value: Int
    let title: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(value)").font(.title2.bold()).foregroundStyle(color)
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct DocumentRow: View {
    let document: ExportDocument
    let open: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(statusColor(document.status)).frame(width: 9, height: 9).padding(.top, 6)
            VStack(alignment: .leading, spacing: 5) {
                Text(document.displayName).font(.headline).lineLimit(1)
                Text(document.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            Text(document.status.uppercased())
                .font(.caption2.bold()).foregroundStyle(statusColor(document.status))
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(statusColor(document.status).opacity(0.12), in: Capsule())
            if document.output != nil {
                Button("Open", action: open).buttonStyle(.borderless)
            }
        }
        .padding(12)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.separator.opacity(0.7)))
    }
}

struct ContentView: View {
    @StateObject private var model = ExportModel()

    private var counts: [String: Int] {
        Dictionary(grouping: model.documents, by: \.status).mapValues(\.count)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    inputSection
                    if !model.documents.isEmpty { resultsSection }
                    logSection
                }
                .padding(24)
            }
        }
        .frame(minWidth: 760, minHeight: 650)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .scaledToFit()
                .frame(width: 42, height: 42)
            VStack(alignment: .leading, spacing: 2) {
                Text("Feishu Grabber").font(.title2.bold())
                Text(model.message).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.isRunning { ProgressView().controlSize(.small) }
            Button("Log in to Feishu") { model.login() }
                .disabled(model.isRunning)
        }
        .padding(.horizontal, 24).padding(.vertical, 16)
    }

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Document links").font(.headline)
            TextEditor(text: $model.urlsText)
                .font(.system(.body, design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(10)
                .frame(height: 118)
                .background(.background, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator))
            Text("Paste one or more Feishu/Lark links, separated by spaces or new lines.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Image(systemName: "folder").foregroundStyle(.secondary)
                Text(model.outputBase.path).lineLimit(1).truncationMode(.middle)
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Choose folder") { model.chooseOutputFolder() }
                    .disabled(model.isRunning)
            }
            HStack {
                if model.isRunning {
                    Button("Cancel", role: .destructive) { model.cancel() }
                }
                Spacer()
                Button {
                    model.export()
                } label: {
                    Label(model.isRunning ? "Exporting…" : "Export", systemImage: "arrow.down.doc.fill")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(model.isRunning)
            }
        }
        .padding(18)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))
    }

    private var resultsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Results").font(.headline)
                Spacer()
                Button("Open results") { model.openResultPage() }
                Button("Show in Finder") { model.openOutputFolder() }
            }
            HStack(spacing: 10) {
                MetricView(value: counts["complete", default: 0], title: "Complete", color: .green)
                MetricView(value: counts["degraded", default: 0], title: "Degraded", color: .orange)
                MetricView(value: counts["incomplete", default: 0], title: "Incomplete", color: .red)
                MetricView(value: counts["failed", default: 0], title: "Failed", color: .red)
            }
            ForEach(model.documents) { document in
                DocumentRow(document: document) { model.openOutput(document) }
            }
            if model.retryCount > 0 {
                HStack {
                    Text("\(model.retryCount) document(s) did not reach complete.")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Retry incomplete") { model.retry() }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.isRunning)
                }
                .padding(.top, 4)
            }
        }
    }

    private var logSection: some View {
        DisclosureGroup("Run log", isExpanded: $model.showLog) {
            ScrollView {
                Text(model.logText.isEmpty ? "No output yet." : model.logText)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(maxHeight: 180)
            .background(.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 8))
            .foregroundStyle(.white.opacity(0.9))
            .padding(.top, 8)
        }
        .font(.caption)
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
        .defaultSize(width: 860, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) { }
        }
    }
}

class FeishuGrab < Formula
  desc "Export Feishu and Lark documents using your daily Chrome session"
  homepage "https://github.com/Popcornnnnnnnn/feishu-doc-grabber"
  url "https://github.com/Popcornnnnnnnn/feishu-doc-grabber.git",
      tag: "v1.3.0",
      revision: "dd6130ad1e5a68a417b8f8a9d232b260397443f3"
  version "1.3.0"
  license "ISC"

  depends_on "node"
  depends_on :macos

  def install
    libexec.install "cli.mjs", "grab.mjs", "lib", "package.json", "package-lock.json"
    (libexec/"tools").install "tools/ai-chrome.mjs"
    ENV.prepend_path "PATH", Formula["node"].opt_libexec/"bin"
    cd libexec do
      system "npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
    end

    { "feishu-grab" => "cli.mjs", "feishu-chrome" => "tools/ai-chrome.mjs" }.each do |name, script|
      (bin/name).write <<~SH
        #!/bin/sh
        exec "#{Formula["node"].opt_bin}/node" "#{libexec/script}" "$@"
      SH
    end
    man1.install "docs/feishu-grab.1"
    doc.install "README.md", "INTEGRITY.md", "CHANGELOG.md", "LICENSE"

    { bash_completion/"feishu-grab" => "bash", zsh_completion/"_feishu-grab" => "zsh",
      fish_completion/"feishu-grab.fish" => "fish" }.each do |path, shell|
      path.dirname.mkpath
      path.write Utils.safe_popen_read(bin/"feishu-grab", "completion", shell)
    end
  end

  def caveats
    <<~EOS
      Open a Feishu document in your daily Google Chrome and enable:
        View > Developer > Allow JavaScript from Apple Events
      If prompted by macOS, allow your terminal to control Google Chrome.

      Get started:
        feishu-grab --help
        feishu-grab doctor
        feishu-grab current --out ./exports

      Authentication stays in Chrome. No browser extension is required.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/feishu-grab --version").strip
    assert_match "Commands:", shell_output("#{bin}/feishu-grab --help")
    assert_match "Export options:", shell_output("#{bin}/feishu-grab help export")
    assert_match "Unknown option", shell_output("#{bin}/feishu-grab --invalid-option 2>&1", 64)
    (testpath/"report.json").write('{"schemaVersion":1,"documents":[]}')
    assert_match "0 document(s)", shell_output("#{bin}/feishu-grab report #{testpath}/report.json")
    assert_match "schemaVersion", shell_output("#{bin}/feishu-grab report #{testpath}/report.json --json")
    assert_match "#compdef feishu-grab", shell_output("#{bin}/feishu-grab completion zsh")
  end
end

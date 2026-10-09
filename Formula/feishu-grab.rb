class FeishuGrab < Formula
  desc "Export Feishu and Lark documents using your daily Chrome session"
  homepage "https://github.com/Popcornnnnnnnn/feishu-doc-grabber"
  # This private repository is its own tap. The tap clone already used Git's
  # configured authentication; fetching its pinned tag needs no credentials.
  url "file://#{__dir__}/..",
      using:    :git,
      tag:      "v1.3.1",
      revision: "647f01f0acecd757cb68df6dbce006a649cdd141"
  version "1.3.1"
  license "ISC"

  depends_on :macos
  depends_on "node"

  def install
    libexec.install "cli.mjs", "grab.mjs", "lib", "package.json", "package-lock.json"
    (libexec/"tools").install "tools/ai-chrome.mjs"
    ENV.prepend_path "PATH", formula_opt_libexec("node")/"bin"
    cd libexec do
      system "npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
    end

    { "feishu-grab" => "cli.mjs", "feishu-chrome" => "tools/ai-chrome.mjs" }.each do |name, script|
      (bin/name).write <<~SH
        #!/bin/sh
        exec "#{formula_opt_bin("node")}/node" "#{libexec/script}" "$@"
      SH
      (bin/name).chmod 0755
    end
    man1.install "docs/feishu-grab.1"
    doc.install "README.md", "INTEGRITY.md", "CHANGELOG.md", "LICENSE"

    { bash_completion/"feishu-grab" => "bash", zsh_completion/"_feishu-grab" => "zsh",
      fish_completion/"feishu-grab.fish" => "fish" }.each do |path, shell|
      path.dirname.mkpath
      path.write Utils.safe_popen_read((bin/"feishu-grab").to_s, "completion", shell)
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

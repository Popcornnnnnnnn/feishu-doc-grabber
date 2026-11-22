# Releasing the command-line tool

Release only committed, task-scoped changes from this repository.
Never package uncommitted desktop prototypes, private test documents, or browser profiles.
The release workflow packages only files allowed by `package.json`.

1. Update the version in `package.json`, the root package in `package-lock.json`,
   `CHANGELOG.md`, and `docs/feishu-grab.1`.
2. Run `npm ci --ignore-scripts`, `npm test`, and `npm pack --dry-run` in a clean checkout.
3. Commit and push the validated code to `origin/main`. Create an annotated tag
   such as `git tag -a v1.4.0 -m 'Feishu Grabber 1.4.0'`, then `git push origin v1.4.0`.
4. The tag workflow tests the code on macOS, checks that the tag matches the version,
   and publishes the npm archive plus `SHA256SUMS` to a GitHub release. Verify that
   the workflow succeeds and that both release assets exist.
   To replay it, use `gh workflow run release.yml --ref main -f tag=v1.4.0`.
   Replay validates existing asset digests instead of creating or overwriting a release.
5. Download the tagged source tarball (`https://github.com/Popcornnnnnnnn/feishu-doc-grabber/archive/refs/tags/v1.4.0.tar.gz`)
   and compute its SHA-256 digest.
6. Update `Formula/feishu-grab.rb` in [Popcornnnnnnnn/homebrew-tap](https://github.com/Popcornnnnnnnn/homebrew-tap)
   with the new tag URL and `sha256`, commit, and push.
7. Run `brew update && brew upgrade Popcornnnnnnnn/tap/feishu-grab` followed by
   `brew test Popcornnnnnnnn/tap/feishu-grab`.

First-time Homebrew installation uses:

```bash
brew install Popcornnnnnnnn/tap/feishu-grab
```

It installs the Node dependencies in its own Cellar, the `feishu-grab`, `feishu-grab-mcp`,
and `feishu-chrome` executables, a manual page, and bash/zsh/fish completions. It does not
depend on the developer's checkout or modify shell config files.

Homebrew installation, CLI tests, and `doctor` connection checks do not prove live
Feishu compatibility. Verify a real read-only export and its integrity report separately
after Chrome permissions are available; never create test documents in a company tenant.

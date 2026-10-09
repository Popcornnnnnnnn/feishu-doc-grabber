# Releasing the command-line tool

Release only committed, task-scoped changes from the established private repository.
Never package uncommitted desktop prototypes, private test documents, or browser profiles.
The release workflow packages only files allowed by `package.json`.

1. Update the version in `package.json`, the root package in `package-lock.json`,
   `CHANGELOG.md`, and the manual page.
2. Run `npm ci --ignore-scripts`, `npm test`, and `npm pack --dry-run` in a clean checkout.
3. Commit and push the validated code to the private remote. Create an annotated tag
   such as `git tag -a v1.3.0 -m 'Feishu Grabber 1.3.0'`, then `git push origin v1.3.0`.
4. The tag workflow tests the code on macOS, checks that the tag matches the version,
   and publishes the npm archive plus `SHA256SUMS` to a GitHub release. Verify that
   the workflow succeeds and that both release assets exist.
   To replay it, use `gh workflow run release.yml --ref main -f tag=v1.3.2`.
   Replay validates existing asset digests instead of creating or overwriting a release.
5. Update `Formula/feishu-grab.rb` to the new version, tag, and exact tagged commit.
   Commit and push the formula update to the same private repository.
6. Refresh the tap and run `brew reinstall popcornnnnnnnn/feishu-doc-grabber/feishu-grab`
   followed by `brew test popcornnnnnnnn/feishu-doc-grabber/feishu-grab`.

The source repository is also its own tap. First-time private installation uses:

```bash
brew tap popcornnnnnnnn/feishu-doc-grabber https://github.com/Popcornnnnnnnn/feishu-doc-grabber.git
brew install popcornnnnnnnn/feishu-doc-grabber/feishu-grab
```

Private installation needs Git access already configured for this repository.
If access is not configured, use the normal `gh auth login` / `gh auth setup-git`
flow. Do not paste a token into a formula, download URL, or shell command.

Homebrew authenticates when cloning or updating the tap. The formula fetches its
pinned tag and revision from that local tap clone, so the download sandbox does not
need access to credentials or the macOS keychain. The tap retains the release tags.
It installs the Node dependencies in its own Cellar, a manual page, and bash/zsh/fish
completions. It does not depend on the developer's checkout or modify shell config files.
Publishing to a public tap or changing repository visibility is a separate decision.

Homebrew installation, CLI tests, and `doctor` connection checks do not prove live
Feishu compatibility. Verify a real read-only export and its integrity report separately
after Chrome permissions are available; never create test documents in a company tenant.

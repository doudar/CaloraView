# Releases and GitHub Actions

Every push to `main` runs `.github/workflows/release.yml`. Pull requests run `.github/workflows/build.yml`; the build workflow can also be started manually without publishing.

## Release sequence

1. Fetch all tags and choose one patch above the highest stable `vMAJOR.MINOR.PATCH` tag or `package.json` baseline, whichever is greater. With baseline `0.1.0` and no tags, the first release is `v0.1.1`.
2. Set that version in each build's temporary `package.json` and lockfile. No version-bump commit is pushed, so no release loop is created.
3. Install with `npm ci`, audit repository contents, run unit tests, and build the Windows x64 NSIS setup installer and macOS ARM64 PKG installer on their native runners.
4. Install both packages on disposable CI runners and verify their installed application contents. Windows also checks shortcuts, Installed apps registration, and uninstallation.
5. Only after both builds and installation checks succeed, create a draft release/tag at the triggering commit, upload both installers and `SHA256SUMS.txt`, and publish it.

Only the publish job has `contents: write`. No personal access token is needed. Build jobs have read-only permissions. The workflow publishes directly because pushes made with `GITHUB_TOKEN` do not start another tag workflow ([GitHub token behavior](https://docs.github.com/en/actions/concepts/security/github_token)).

The complete release workflow is serialized with `queue: max`, preserving pending pushes up to GitHub's 100-run queue limit ([concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)). Versions follow queue execution order. A push with failing checks does not publish a release; fix the failure and rerun or push the fix.

## Setup and retries

Enable GitHub Actions and allow the workflow's `contents: write` permission. Repository or organization rules that prohibit tag creation or release publishing must allow this workflow. Both workflows use GitHub-hosted runners. No signing credentials are configured; binaries are unsigned and macOS is not notarized.

Use **Actions → Release → Run workflow**, selecting `main`, to retry the current commit. Rerunning an already tagged commit reuses its version. A published release is left unchanged; a draft is resumed and its assets replaced before publication. Tags pointing at a different commit are rejected. Do not move or reuse release tags manually.

`package.json` is a baseline rather than the latest published release number. To advance the major/minor series, update it and the root lockfile version together; the next release increments that baseline's patch. Packaged app versions and filenames always use the selected release version.

Windows filenames end in `win-x64-Setup.exe`; macOS filenames end in `mac-arm64-Installer.pkg`. The Windows wizard supports selecting the install directory, creates shortcuts, registers an uninstaller, and retains user data on uninstall. The macOS package installs to `/Applications`. The release asset allowlist rejects the earlier portable EXE and DMG filenames. Intel Macs can be built locally using matching x64 Node.js and dependencies, but are not in the release matrix. Camera factory download and shutter controls still require Windows; see [macOS status](MACOS.md).

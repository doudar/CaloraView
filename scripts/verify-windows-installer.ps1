$ErrorActionPreference = 'Stop'
# Installation tests run only on disposable GitHub-hosted Windows runners.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This installation smoke test requires a disposable GitHub-hosted Windows runner.'
}
$installers = @(Get-ChildItem -LiteralPath 'dist' -Filter '*-Setup.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows setup installer.' }
$installRoot = Join-Path $env:RUNNER_TEMP 'caloraview-installer-smoke'
if (Test-Path -LiteralPath $installRoot) { throw 'Installer test directory already exists.' }
$installProcess = Start-Process -FilePath $installers[0].FullName -ArgumentList "/S /currentuser /D=$installRoot" -WindowStyle Hidden -Wait -PassThru
if ($installProcess.ExitCode -ne 0) { throw "Installer failed: $($installProcess.ExitCode)" }
foreach ($relative in @('Caloraview Desktop.exe', 'resources/app.asar', 'resources/native/Caloraview.CameraControl.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot $relative))) { throw "Installed file missing: $relative" }
}
node scripts/verify-package.cjs (Join-Path $installRoot 'resources/app.asar')
if ($LASTEXITCODE -ne 0) { throw 'Installed application contents failed verification.' }
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Caloraview Desktop.lnk'
$menuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Caloraview Desktop.lnk'
foreach ($shortcut in @($desktopShortcut, $menuShortcut)) {
    if (-not (Test-Path -LiteralPath $shortcut)) { throw "Missing shortcut: $shortcut" }
}
$registration = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object { $_.DisplayName -like 'Caloraview Desktop*' })
if ($registration.Count -ne 1) { throw 'Expected one Installed apps registration.' }
$uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Filter '*Uninstall*.exe' -File)
if ($uninstallers.Count -ne 1) { throw 'Installed uninstaller missing.' }
$uninstallProcess = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S /currentuser' -WindowStyle Hidden -Wait -PassThru
if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstallProcess.ExitCode)" }
# NSIS can hand off to a temporary uninstaller process.
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (((Test-Path -LiteralPath (Join-Path $installRoot 'Caloraview Desktop.exe')) -or
        (Test-Path -LiteralPath $desktopShortcut) -or
        (Test-Path -LiteralPath $menuShortcut) -or
        (Test-Path -LiteralPath $registration[0].PSPath)) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
}
if (Test-Path -LiteralPath (Join-Path $installRoot 'Caloraview Desktop.exe')) { throw 'Uninstall left the application executable behind.' }
foreach ($shortcut in @($desktopShortcut, $menuShortcut)) {
    if (Test-Path -LiteralPath $shortcut) { throw "Uninstall left a shortcut behind: $shortcut" }
}
if (Test-Path -LiteralPath $registration[0].PSPath) { throw 'Uninstall left its Installed apps registration behind.' }
Write-Output 'Windows install, shortcuts, registration, payload and uninstall verified.'

param(
    [switch]$CycleShutter,
    [ValidateRange(500, 2000)][int]$HoldMilliseconds = 500,
    [string]$DeviceMatch = 'vid_38be&pid_0184',
    [string]$ExtensionGuid = 'a29e7641-de04-47e3-8b2b-f4341aff003b',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../research/ks-controls'),
    [switch]$CompileOnly
)
$ErrorActionPreference = 'Stop'
if (-not ('Caloraview.Protocol.KsCameraControl' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'KsCameraControl.cs') }
if ($CompileOnly) { Write-Output 'Verified-layout shutter helper compiled; no device commands issued.'; return }
if (-not $CycleShutter) {
    & (Join-Path $PSScriptRoot 'read-ks-selected.ps1') -Command image-enhancement-ex -DeviceMatch $DeviceMatch -ExtensionGuid $ExtensionGuid -OutputDirectory $OutputDirectory
    return
}
$result = [Caloraview.Protocol.KsCameraControl]::CycleShutter($DeviceMatch, $ExtensionGuid, $HoldMilliseconds)
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$report = [pscustomobject]@{ timestampUtc = [DateTime]::UtcNow.ToString('o'); holdMilliseconds = $HoldMilliseconds; devices = @($result) }
$json = $report | ConvertTo-Json -Depth 12
$json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'shutter-cycle.json') -Encoding UTF8
$json
if ($result.Count -eq 0) { throw 'No matching camera was found.' }
foreach ($device in $result) {
    if ($device.Error) { throw $device.Error }
    foreach ($node in $device.Nodes) { if ($node.Error) { throw $node.Error } }
}

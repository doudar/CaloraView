param(
    [string]$DeviceMatch = 'vid_38be&pid_0184',
    [string]$ExtensionGuid = 'a29e7641-de04-47e3-8b2b-f4341aff003b',
    [uint32[]]$Selectors = @(4),
    [uint32]$FallbackReadBytes = 512,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../research/ks-controls'),
    [switch]$CompileOnly
)
$ErrorActionPreference = 'Stop'
if (-not ('Caloraview.Protocol.KsCameraControl' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'KsCameraControl.cs')
}
if ($CompileOnly) { Write-Output 'Read-only KS control helper compiled.'; return }
$result = [Caloraview.Protocol.KsCameraControl]::Read($DeviceMatch, $ExtensionGuid, $Selectors, $FallbackReadBytes)
if ($result.Count -eq 0) { throw "No DirectShow camera matching $DeviceMatch was found." }
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$report = [pscustomobject]@{
    timestampUtc = [DateTime]::UtcNow.ToString('o')
    access = 'read-only GET queries; no KS SET requests issued by this command'
    devices = @($result)
}
$json = $report | ConvertTo-Json -Depth 12
$json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'latest.json') -Encoding UTF8
$json | Set-Content -LiteralPath (Join-Path $OutputDirectory ('selectors-{0}.json' -f ($Selectors -join '-'))) -Encoding UTF8
$json

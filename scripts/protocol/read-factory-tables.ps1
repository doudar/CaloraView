param(
    [string]$DeviceMatch = 'vid_38be&pid_0184',
    [int[]]$FileTypes = @(4,11,14),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../research/factory-tables'),
    [switch]$SizeOnly,
    [switch]$DirectLengths,
    [switch]$CompileOnly
)
$ErrorActionPreference='Stop'
if (-not ('Caloraview.Protocol.KsFactoryDownload' -as [type])) {
    if ('Caloraview.Protocol.KsCameraControl' -as [type]) { throw 'Use a fresh PowerShell process so both helper sources compile into one assembly.' }
    Add-Type -Path @((Join-Path $PSScriptRoot 'KsCameraControl.cs'),(Join-Path $PSScriptRoot 'KsFactoryDownload.cs'))
}
if($CompileOnly) { 'Factory download helper compiled; no hardware opened.'; return }
$resolvedOutput=[IO.Path]::GetFullPath($OutputDirectory)
$null=New-Item -ItemType Directory -Force -Path $resolvedOutput
$results=[Caloraview.Protocol.KsFactoryDownload]::Read($DeviceMatch,$FileTypes,$resolvedOutput,$SizeOnly.IsPresent,$DirectLengths.IsPresent)
if($results.Count -eq 0) { throw 'No matching SK02 extension unit found.' }
$report=[pscustomobject]@{timestampUtc=[DateTime]::UtcNow.ToString('o');access='Factory download only; transient command/file-source selection. No upload or persistent setting writes.';sizeOnly=$SizeOnly.IsPresent;directLengths=$DirectLengths.IsPresent;tables=@($results)}
$name='factory-download-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')+'.json'
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $resolvedOutput $name) -Encoding UTF8
$results | Select-Object FileType,Name,AnnouncedBytes,DownloadedBytes,Sha256,DataPath,Error | ConvertTo-Json -Depth 4
if(@($results | Where-Object Error).Count -gt 0) { throw 'Factory download stopped; inspect the saved transaction report.' }

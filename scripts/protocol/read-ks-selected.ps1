param(
    [ValidateSet('image-enhancement-ex', 'thermometry-calibration')]
    [string]$Command = 'image-enhancement-ex',
    [string]$DeviceMatch = 'vid_38be&pid_0184',
    [string]$ExtensionGuid = 'a29e7641-de04-47e3-8b2b-f4341aff003b',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../research/ks-controls')
)
$ErrorActionPreference = 'Stop'
if (-not ('Caloraview.Protocol.KsCameraControl' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'KsCameraControl.cs') }
$result = [Caloraview.Protocol.KsCameraControl]::ReadSelected($DeviceMatch, $ExtensionGuid, $Command)
if ($result.Count -eq 0) { throw "No DirectShow camera matching $DeviceMatch was found." }
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$report = [pscustomobject]@{
    timestampUtc = [DateTime]::UtcNow.ToString('o')
    command = $Command
    access = 'read transaction; only transient selector5 command selection is written'
    devices = @($result)
}
$json = $report | ConvertTo-Json -Depth 12
$json | Set-Content -LiteralPath (Join-Path $OutputDirectory "$Command.json") -Encoding UTF8
foreach ($device in $result) {
    foreach ($node in $device.Nodes) {
        foreach ($query in $node.Queries) {
            if ($query.Operation -eq 'GET_CURRENT' -and $query.HResult -eq '0x00000000' -and $query.Hex.Length -gt 0) {
                $bytes = [byte[]]::new($query.Hex.Length / 2)
                for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($query.Hex.Substring($i * 2, 2), 16) }
                $destination = Join-Path $OutputDirectory ("{0}-node{1}-selector{2}.bin" -f $Command, $node.NodeId, $query.Selector)
                [IO.File]::WriteAllBytes($destination, $bytes)
                Get-FileHash -LiteralPath $destination -Algorithm SHA256 | Format-List
            }
        }
    }
}
$json

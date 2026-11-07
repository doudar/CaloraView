param(
    [UInt16]$VendorId = 0x38be,
    [UInt16]$ProductId = 0x0184,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../research/usb-descriptors'),
    [switch]$CompileOnly
)
$ErrorActionPreference = 'Stop'
if (-not ('Caloraview.Protocol.UsbDescriptorReader' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'UsbDescriptorReader.cs')
}
if ($CompileOnly) { Write-Output 'Read-only descriptor helper compiled.'; return }
$devices = [Caloraview.Protocol.UsbDescriptorReader]::Read($VendorId, $ProductId)
if ($devices.Count -eq 0) { throw ('No accessible USB device {0:x4}:{1:x4} found.' -f $VendorId, $ProductId) }
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$deviceIndex = 0
foreach ($device in $devices) {
    $bytes = $device.Configuration
    $prefix = Join-Path $OutputDirectory ('{0:x4}-{1:x4}-{2}' -f $VendorId, $ProductId, $deviceIndex)
    [IO.File]::WriteAllBytes("$prefix.bin", $bytes)
    $units = @()
    $interface = -1
    $class = -1
    $subclass = -1
    for ($offset = 0; $offset -lt $bytes.Length;) {
        $length = [int]$bytes[$offset]
        if ($length -lt 2 -or $offset + $length -gt $bytes.Length) { throw "Invalid USB descriptor at $offset" }
        $kind = $bytes[$offset + 1]
        if ($kind -eq 4 -and $length -ge 9) {
            $interface = $bytes[$offset + 2]
            $class = $bytes[$offset + 5]
            $subclass = $bytes[$offset + 6]
        }
        if ($kind -eq 0x24 -and $class -eq 14 -and $subclass -eq 1 -and $length -ge 24 -and $bytes[$offset + 2] -eq 6) {
            [byte[]]$guidBytes = $bytes[($offset+4)..($offset+19)]
            $pins = [int]$bytes[$offset + 21]
            $controlSizeOffset = $offset + 22 + $pins
            if ($controlSizeOffset -ge $offset + $length) { throw 'Truncated extension-unit descriptor.' }
            $controlSize = [int]$bytes[$controlSizeOffset]
            if ($controlSizeOffset + 1 + $controlSize -ge $offset + $length) { throw 'Truncated extension-unit control bitmap.' }
            $selectors = @()
            for ($bit = 0; $bit -lt 8 * $controlSize; $bit++) {
                if ($bytes[$controlSizeOffset + 1 + [int][Math]::Floor($bit / 8)] -band (1 -shl ($bit % 8))) { $selectors += $bit + 1 }
            }
            $units += [pscustomobject]@{
                interfaceNumber = $interface
                unitId = [int]$bytes[$offset+3]
                guid = ([Guid]::new($guidBytes)).ToString()
                numControls = [int]$bytes[$offset+20]
                controlSelectors = $selectors
                usbWIndex = (([int]$bytes[$offset+3] -shl 8) -bor $interface)
            }
        }
        $offset += $length
    }
    $report = [pscustomobject]@{ vendorId=$VendorId; productId=$ProductId; hubPath=$device.HubPath; port=$device.Port; configurationBytes=$bytes.Length; extensionUnits=$units }
    $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 "$prefix.json"
    $report | ConvertTo-Json -Depth 8
    $deviceIndex++
}

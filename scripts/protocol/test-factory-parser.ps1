$ErrorActionPreference='Stop'
Add-Type -Path @((Join-Path $PSScriptRoot 'KsCameraControl.cs'),(Join-Path $PSScriptRoot 'KsFactoryDownload.cs'))
function Reject-Chunk([byte[]]$Packet,[long]$Total,[long]$Have) {
    try { [void][Caloraview.Protocol.KsFactoryDownload]::GetFileChunkPayloadLength($Packet,$Total,$Have) }
    catch { return }
    throw 'Malformed factory chunk was accepted.'
}
$fullPacket=New-Object byte[] 512
$finalPacket=[byte[]]@(255,120,86,52,18,10,20,30)
if([Caloraview.Protocol.KsFactoryDownload]::GetFileChunkPayloadLength($fullPacket,510,0) -ne 507) {throw 'Full payload length incorrect.'}
if([Caloraview.Protocol.KsFactoryDownload]::GetFileChunkPayloadLength($finalPacket,510,507) -ne 3) {throw 'Short final packet rejected.'}
Reject-Chunk ([byte[]]@(0,0,0,0,0)) 510 0
Reject-Chunk $fullPacket 510 507
Reject-Chunk $finalPacket 510 510
Reject-Chunk $finalPacket 510 -1
Reject-Chunk (New-Object byte[] 513) 1000 0
'Factory parser: full and short final chunks accepted; empty, padded overrun, completed, negative and oversized inputs rejected. No hardware opened.'

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$runId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$traceName = 'CaloraviewFactoryHeaders-' + $runId
$outputRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../research/factory-tables'))
$runDirectory = Join-Path $outputRoot ('trace-' + $runId)
$tracePath = Join-Path $runDirectory 'headers.etl'
$probeScript = Join-Path $PSScriptRoot 'read-factory-tables.ps1'
$shellPath = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$logmanPath = Join-Path $env:SystemRoot 'System32/logman.exe'

# The installed provider inventory (logman query providers Microsoft-Windows-USB-UCX)
# identifies 0x40 as HeadersBusTrace; 0x80/0x100 log payloads and are NOT enabled.
# -ets operates only on this live session, without creating a persistent collector.
$traceArguments = @('create', 'trace', $traceName, '-o', $tracePath,
    '-f', 'bincirc', '-max', '16',
    '-p', 'Microsoft-Windows-USB-UCX', '0x40', '5', '-ets')
$plan = [ordered]@{
    traceName = $traceName; runDirectory = $runDirectory; tracePath = $tracePath
    provider = 'Microsoft-Windows-USB-UCX'; keywords = '0x40 (HeadersBusTrace only)'
    maxEtlMegabytes = 16; probeTimeoutSeconds = 30; watchdogStopAttemptAfterSeconds = 35
    watchdog = 'Independent hidden PowerShell child launched before trace creation; stops only traceName.'
    fileType = 11; sizeOnly = $true
    scope = 'Transient factory read selection only; no shutter, settings, uploads, installs, or driver changes.'
    logmanArguments = $traceArguments
}
if ($DryRun) { $plan | ConvertTo-Json -Depth 5; return }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Windows requires an elevated administrator process for this USB trace. No trace was started. This script does not request UAC itself.'
    }
} finally { $identity.Dispose() }

$null = New-Item -ItemType Directory -Path $runDirectory
$plan | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDirectory 'plan.json') -Encoding UTF8
$traceStartAttempted = $false
$watchdogProcess = $null
$watchdogProcessId = $null
$traceStartClock = $null
$probeProcess = $null
$probeTimedOut = $false
$probeExitCode = $null
$traceStopExitCode = $null
$failure = $null
$startedUtc = [DateTime]::UtcNow.ToString('o')
try {
    # Independent process: survives parent errors or termination. The unique session
    # name is the only object it can stop; no device commands or broad cleanup.
    $quotedLogman = "'" + $logmanPath.Replace("'", "''") + "'"
    $quotedTraceName = "'" + $traceName.Replace("'", "''") + "'"
    $watchdogCommand = '$ErrorActionPreference = ''Continue''; Start-Sleep -Seconds 35; & ' +
        $quotedLogman + ' stop ' + $quotedTraceName + ' -ets; exit $LASTEXITCODE'
    $watchdogEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchdogCommand))
    $watchdogProcess = Start-Process -FilePath $shellPath -WindowStyle Hidden -PassThru `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $watchdogEncoded) `
        -RedirectStandardOutput (Join-Path $runDirectory 'watchdog-stdout.txt') `
        -RedirectStandardError (Join-Path $runDirectory 'watchdog-stderr.txt')
    $watchdogProcessId = $watchdogProcess.Id
    $traceStartClock = [Diagnostics.Stopwatch]::StartNew()
    if ($watchdogProcess.HasExited) { throw 'Independent trace watchdog exited before trace creation; no trace was started.' }
    $traceStartAttempted = $true
    & $logmanPath @traceArguments | Set-Content -LiteralPath (Join-Path $runDirectory 'trace-start.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Windows could not start the bounded USB header trace; inspect trace-start.txt.' }
    # Do not begin probing after a delayed create has consumed the watchdog window.
    # The finally block still stops this session if creation completed late.
    if ($traceStartClock.Elapsed.TotalSeconds -ge 30 -or $watchdogProcess.HasExited) {
        throw 'Trace creation consumed the watchdog window; stopping this session without probing.'
    }

    # Encode a fixed PowerShell program, quoting only two filesystem literals.
    # This avoids command-line interpolation and works in Windows PowerShell 5.1.
    $quotedScript = "'" + $probeScript.Replace("'", "''") + "'"
    $quotedOutput = "'" + $runDirectory.Replace("'", "''") + "'"
    $probeCommand = '$ErrorActionPreference = ''Stop''; try { & ' + $quotedScript +
        ' -FileTypes 11 -SizeOnly -OutputDirectory ' + $quotedOutput +
        '; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }'
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeCommand))
    $probeProcess = Start-Process -FilePath $shellPath -WindowStyle Hidden -PassThru `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand) `
        -RedirectStandardOutput (Join-Path $runDirectory 'probe-stdout.txt') `
        -RedirectStandardError (Join-Path $runDirectory 'probe-stderr.txt')
    if (-not $probeProcess.WaitForExit(30000)) {
        $probeTimedOut = $true
        throw 'Factory size probe exceeded 30 seconds; its own child process is being stopped.'
    }
    $probeProcess.Refresh()
    $probeExitCode = $probeProcess.ExitCode
    if ($probeExitCode -ne 0) { throw 'Factory size probe failed; the trace and probe logs are preserved locally.' }
} catch {
    $failure = $_
} finally {
    # The only child is a size-only read probe, with no shutter movement to recover.
    if ($null -ne $probeProcess) {
        try {
            if (-not $probeProcess.HasExited) {
                $probeProcess.Kill()
                $null = $probeProcess.WaitForExit(5000)
            }
            if ($probeProcess.HasExited) { $probeExitCode = $probeProcess.ExitCode }
        } catch { Write-Warning ('Probe cleanup: ' + $_.Exception.Message) }
        finally { $probeProcess.Dispose() }
    }
    if ($traceStartAttempted) {
        try {
            & $logmanPath stop $traceName -ets | Set-Content -LiteralPath (Join-Path $runDirectory 'trace-stop.txt')
            $traceStopExitCode = $LASTEXITCODE
            if ($traceStopExitCode -ne 0) { Write-Warning 'Trace stop reported failure; inspect trace-stop.txt (the watchdog may already have stopped it, or start may have failed).' }
        } catch { Write-Warning ('Trace cleanup: ' + $_.Exception.Message) }
    }
    if ($null -ne $watchdogProcess) {
        # Disposing our handle leaves the watchdog alive. Never cancel it, including
        # when trace creation or normal cleanup reports failure.
        $watchdogProcess.Dispose()
    }
    [ordered]@{
        startedUtc = $startedUtc; finishedUtc = [DateTime]::UtcNow.ToString('o')
        traceName = $traceName; probeTimedOut = $probeTimedOut
        watchdogProcessId = $watchdogProcessId; watchdogStopAttemptAfterSeconds = 35
        probeExitCode = $probeExitCode; traceStopExitCode = $traceStopExitCode
        error = $(if ($null -ne $failure) { $failure.Exception.Message } else { $null })
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory 'result.json') -Encoding UTF8
}
Write-Output ('Local trace directory: ' + $runDirectory)
if ($null -ne $failure) { throw $failure }

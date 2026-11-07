$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$nativeDirectory=Join-Path $projectRoot 'build/native'
$helper=Join-Path $nativeDirectory 'Caloraview.CameraControl.exe'
if(-not (Test-Path -LiteralPath $helper)){throw 'Run node scripts/build-controls.cjs first.'}
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$testProgram=Join-Path $nativeDirectory 'Caloraview.CalibrationExport.Tests.exe'
& $compiler /nologo /target:exe /platform:x64 "/reference:$helper" "/out:$testProgram" (Join-Path $PSScriptRoot 'CalibrationExportTests.cs')
if($LASTEXITCODE -ne 0){throw 'Calibration export test compilation failed.'}
& $testProgram
if($LASTEXITCODE -ne 0){throw 'Calibration export tests failed.'}

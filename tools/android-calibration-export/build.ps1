param(
  [string]$SdkRoot=(Join-Path $env:LOCALAPPDATA 'Android/Sdk'),
  [string]$JavaRoot='C:/Program Files/Microsoft/jdk-21.0.7.6-hotspot',
  [string]$BuildToolsVersion='36.0.0',
  [switch]$TestOnly
)
$ErrorActionPreference='Stop'
function Invoke-Checked([string]$File,[string[]]$Arguments) {
  & $File @Arguments
  if($LASTEXITCODE -ne 0){throw "Tool failed: $File (exit $LASTEXITCODE)"}
}
$javac=Join-Path $JavaRoot 'bin/javac.exe'
$java=Join-Path $JavaRoot 'bin/java.exe'
$jar=Join-Path $JavaRoot 'bin/jar.exe'
$keytool=Join-Path $JavaRoot 'bin/keytool.exe'
$buildTools=Join-Path $SdkRoot "build-tools/$BuildToolsVersion"
$androidJar=Join-Path $SdkRoot 'platforms/android-35/android.jar'
foreach($required in @($javac,$java,$jar,$keytool,$androidJar,(Join-Path $buildTools 'aapt2.exe'),(Join-Path $buildTools 'zipalign.exe'))){if(-not(Test-Path -LiteralPath $required)){throw "Required local build dependency missing: $required"}}
$buildRoot=Join-Path $PSScriptRoot 'build'
$run=Join-Path $buildRoot ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
foreach($directory in @($run,(Join-Path $run 'tests'),(Join-Path $run 'classes'),(Join-Path $run 'dex'))){$null=New-Item -ItemType Directory -Force -Path $directory}
$core=Join-Path $PSScriptRoot 'src/com/caloraview/export/CalibrationProtocol.java'
$test=Join-Path $PSScriptRoot 'test/com/caloraview/export/ProtocolTest.java'
Invoke-Checked $javac @('--release','8','-d',(Join-Path $run 'tests'),$core,$test)
Invoke-Checked $java @('-cp',(Join-Path $run 'tests'),'com.caloraview.export.ProtocolTest',(Join-Path $run 'synthetic-export'))
if($TestOnly){return}
$sources=@(Get-ChildItem (Join-Path $PSScriptRoot 'src') -Recurse -Filter '*.java' | ForEach-Object FullName)
Invoke-Checked $javac (@('--release','8','-cp',$androidJar,'-d',(Join-Path $run 'classes'))+$sources)
$classes=@(Get-ChildItem (Join-Path $run 'classes') -Recurse -Filter '*.class' | ForEach-Object FullName)
Invoke-Checked $java (@('-cp',(Join-Path $buildTools 'lib/d8.jar'),'com.android.tools.r8.D8','--min-api','26','--lib',$androidJar,'--output',(Join-Path $run 'dex'))+$classes)
$unsigned=Join-Path $run 'unsigned.apk'
Invoke-Checked (Join-Path $buildTools 'aapt2.exe') @('link','--manifest',(Join-Path $PSScriptRoot 'AndroidManifest.xml'),'-I',$androidJar,'-o',$unsigned)
Invoke-Checked $jar @('uf',$unsigned,'-C',(Join-Path $run 'dex'),'classes.dex')
$aligned=Join-Path $run 'aligned.apk'
Invoke-Checked (Join-Path $buildTools 'zipalign.exe') @('-f','4',$unsigned,$aligned)
$key=Join-Path $buildRoot 'caloraview-local-research.keystore'
if(-not(Test-Path -LiteralPath $key)) {
  Invoke-Checked $keytool @('-genkeypair','-noprompt','-keystore',$key,'-storepass','android','-keypass','android','-alias','research','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=Caloraview Local Research')
}
$apk=Join-Path $buildRoot 'Caloraview-Calibration-Export.apk'
Invoke-Checked $java @('-jar',(Join-Path $buildTools 'lib/apksigner.jar'),'sign','--ks',$key,'--ks-key-alias','research','--ks-pass','pass:android','--key-pass','pass:android','--out',$apk,$aligned)
Invoke-Checked $java @('-jar',(Join-Path $buildTools 'lib/apksigner.jar'),'verify','--verbose',$apk)
Get-FileHash -LiteralPath $apk -Algorithm SHA256 | Select-Object Path,Hash | Format-List
Write-Output 'Built locally only. No adb command, device installation or Android-device data access was performed.'

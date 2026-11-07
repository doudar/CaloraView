const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform === 'win32') {
  const output = path.resolve('build/native');
  fs.mkdirSync(output, { recursive: true });
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const result = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize+',
    `/out:${path.join(output, 'Caloraview.CameraControl.exe')}`, '/reference:System.Web.Extensions.dll',
    path.resolve('scripts/protocol/KsCameraControl.cs'), path.resolve('scripts/protocol/KsFactoryDownload.cs'),
    path.resolve('scripts/protocol/CalibrationExport.cs'), path.resolve('scripts/protocol/CameraControlProgram.cs')
  ], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}

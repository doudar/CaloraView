'use strict';
const { validateExport, FORMAT } = require('../../src/core/calibration-export.cjs');
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[1] !== '--expected-serial') {
    console.error('Usage: node scripts/research/validate-calibration-export.cjs <directory> --expected-serial <serial>');
    process.exitCode = 2;
  } else {
    const report = validateExport(args[0], { expectedSerial: args[2] });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.valid ? 0 : 1;
  }
}
module.exports = { validateExport, FORMAT };

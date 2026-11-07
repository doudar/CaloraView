# Android SK02 calibration export helper

Experimental fallback for obtaining this camera's own factory data through Android's direct USB control-transfer API. It is separate from the desktop app and is not a required desktop dependency. The original helper successfully exported all requested files on the authorized Kindle (Android API 30); a later direct Windows download matched every factory-file hash. The rebranded Caloraview APK is locally built and tested, but has not been installed on the Kindle. It uses package `com.caloraview.export` and therefore does not replace the earlier installed helper automatically.

## What it does

- Lists only USB devices with VID/PID `38be:0184`; the user selects one and grants Android USB access.
- Verifies the known extension-unit GUID, unit 10/interface 0 and protocol `2.0` before reading data.
- Reads factory file types 4/11/14 as `BPM.bin`, `KMatrix.bin` and `KMatrix2.bin`, plus the separate selector 3/subcommand 14 thermometry body.
- Saves complete files, raw identity, exact control-transfer logs and a SHA256 manifest through Android's standard **Create document** picker.
- Reports partial exports clearly. Failed or incomplete reads are never padded into calibration files.

There are no shutter, camera-setting, firmware, upload, reset or arbitrary USB-command paths. The only USB OUT transfers are the exact allowlisted query selections and factory-source handshake described in [the protocol investigation](../../docs/protocol-investigation.md). The app has no internet permission, background service, broad file-access permission or automatic USB attachment handler. Captured data stays in memory until the user chooses an export destination.

Android requires the Camera runtime permission before granting access to USB video-class devices; this helper requests it for that OS requirement. Its code does not open the phone's cameras or enumerate phone media. USB selection and permission follow the [Android USB host API](https://developer.android.com/develop/connectivity/usb/host).

## Local build and tests

No Gradle download or external dependency is required. `build.ps1` uses an installed JDK, Android platform 35 and build-tools 36.0.0. Override paths for another workstation:

```powershell
./tools/android-calibration-export/build.ps1 `
  -SdkRoot 'C:/Users/<user>/AppData/Local/Android/Sdk' `
  -JavaRoot 'C:/Program Files/Microsoft/jdk-21.0.7.6-hotspot'
```

Use `-TestOnly` for pure Java tests. The tests use a scripted in-memory USB transport; they never open hardware. They cover exact write allowlists, malformed lengths, zero/oversized files, source handshake ordering, fresh GET_LEN calls, short final file packets, thermometry reassembly and known SHA256 output.

Output: `build/Caloraview-Calibration-Export.apk`. The script verifies the APK signature and prints its SHA256. A local research signing key is generated under ignored `build/`; it is a development artifact, not a production publishing credential. The script does not run adb or install anything.

## Manual use after review

1. Install the APK manually on an Android 8+ device that supports USB host/OTG.
2. Connect the SK02 directly to that device using a suitable host adapter; close other camera apps.
3. Tap **Select SK02 and read calibration**, select the attached camera, and approve the Android permissions.
4. Wait for the read outcome, then tap **Save export ZIP** and choose its destination.
5. Transfer the ZIP to the computer using your preferred method. Preserve the original ZIP and validate its manifest/serial before treating any file as a calibration input.

The helper first claims the verified VideoControl interface 0 normally. If the Android kernel owns it, the helper retries the standard Android `claimInterface(interface, true)` to temporarily disconnect that kernel binding, then releases its claim and closes its connection in cleanup. This does not install or replace a driver. See the [Android API contract](https://developer.android.com/reference/android/hardware/usb/UsbDeviceConnection#claimInterface(android.hardware.usb.UsbInterface,%20boolean)). A host adapter or powered hub may be required by the Android hardware. USB control requests have a 5-second timeout and the session has a 90-second deadline; cancelling/closing the activity interrupts work and closes its USB connection.

## Export format and limits

`manifest.json` uses format `accuheat-calibration-export-v1` with `createdUtc`, top-level `protocolVersion`, `complete`, structured `device` (`vendorId`, `productId`, `serial`, `model`), `provenance`, `files` (`name`, `bytes`, `sha256`) and per-file `outcomes`. The manifest itself is not self-hashed. Serial comes from Android's USB descriptor access after permission; `unavailable` must not be accepted as a verified camera identity.

Factory sizes are bounded to 16,384 bytes for BPM and 98,304 bytes for each K matrix. Thermometry is bounded to 4 MiB. Each USB packet is bounded to 512 bytes. Hashes detect file alteration after export; they are not vendor signatures or proof that the data yields accurate temperatures.

The source handshake matches the inspected native SDK's unusual logical-length 2/serialized-length 8 behavior. Android performs a fresh vendor GET_LEN before each transfer phase rather than relying on Windows property-size caching. Both 2-byte and 4-byte GET_LEN responses are accepted, with strict packet limits.

The complete thermometry wire body is always retained when successfully read. Extraction expects the UVC2 body layout: 64-byte header, uint32LE file length at 64, then file bytes at 68, with exact length consistency. The protocol prefix/layout still needs confirmation against an actual camera response. The exported data must pass the desktop research validator and native-reference checks before the desktop app can use it for calibrated temperature readings. Bundled vendor fixtures are never substituted for this camera's factory data.

## Offline bundle validation

After extracting an export ZIP into a fresh local directory, run the research validator with the camera's independently known serial:

```powershell
node scripts/research/validate-calibration-export.cjs '<extracted-directory>' --expected-serial '<camera-serial>'
```

A complete synthetic seven-file export from the Java transport test passes this validator, including the thermometry body/extracted-file consistency check. This verifies exporter/validator interoperability only; it does not establish actual Android USB compatibility or calibrated temperature accuracy.
Selector 5 query selection follows the native SDK: a fresh GET_LEN chooses an exact 2-byte or 4-byte prefix of the allowlisted command envelope. Both sizes and rejection of other lengths are covered by the scripted transport tests; the 13-byte factory-source chunk remains fixed as in the native writer.

# macOS transport validation

The Electron interface, decoder, replay, snapshots, CSV logging, and video encoder

use portable code. The macOS camera path uses FFmpeg's AVFoundation input. It has

not been exercised with the SK02 on a Mac; this repository's hardware validation

was performed on Windows. The internal-shutter control helper currently uses

Windows KS interfaces and is unavailable on macOS. Direct factory download is

also Windows-only. The portable processing modules exist, but current Mac

connection setup does not establish the factory/shutter state required for live

temperatures. There is no uniform-target correction setting.

## Build on the target Mac

Use Node.js 22 or later for the Mac's architecture, then install dependencies on

that Mac:

```sh

npm ci

npm test

npm start

npm run dist:mac

```

The installed `ffmpeg-static` package supports both Intel (`x64`) and Apple Silicon

(`arm64`), but downloads one executable for the installation platform/architecture.

Do not reuse a Windows `node_modules` directory or assume a disk image contains a

universal FFmpeg binary. Build and verify each architecture separately. The Windows

control helper is excluded from the macOS package. `NSCameraUsageDescription` is

present in the Electron Builder configuration. The project does not configure

Developer ID signing or notarization.

## Why YUYV matters

The SK02 presents its detector words inside a 264 × 222 YUY2 stream. Each complete

frame contains 117,216 bytes. A normal color conversion can irreversibly change

those words, even if the resulting picture has the same dimensions.

FFmpeg's AVFoundation implementation maps `yuyv422` to Core Video's

`kCVPixelFormatType_422YpCbCr8_yuvs`. It also silently chooses another format if the

requested one is unavailable from the device. That is why this app requests

`yuyv422`, copies encoded packets without conversion, and stops on a negotiated

fallback format. This mapping is present in both the inspected FFmpeg 6.1.1 source

and current source. [FFmpeg AVFoundation source](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n6.1.1/libavdevice/avfoundation.m)

The FFmpeg `capture_raw_data` option is intended for muxed device data; it is not

proof that arbitrary UVC payloads survive macOS capture. Accepting `uyvy422` and

swapping bytes would require separate evidence that only byte order changed.

Do not add an automatic conversion based only on a plausible-looking image.

## First hardware check

1. Close other apps using the SK02. Launch Caloraview and allow camera access when

   requested. If denied, enable access in macOS System Settings and restart.

2. Verify the selected camera advertises 264 × 222 at 25 fps and negotiates

   `yuyv422`. A format mismatch is a failed transport check, not a reason to relax

   validation.

3. Capture and replay a short raw session. Verify its byte length is a multiple

   of 117,216, and compare the full metadata rows and original detector-word

   distributions with Windows captures of the same device. Natural scene changes

   prevent direct whole-frame hash comparisons between separate captures.

4. Confirm sequence timing, image orientation, and the 256 × 192 crop against a

   known scene and the original application. The crop is recovered from the APK;

   its visual interpretation still needs runtime comparison.

5. Verify image saving, MP4 playback, CSV count columns, unplug behavior, and

   clean shutdown while recording. Under the current unsupported Mac calibration

   setup, Celsius fields must remain empty; raw counts should remain available.

The explicit `node scripts/hardware-smoke.cjs` check records 75 frames under

`test-output/` and also works through the macOS capture branch. Inspect its chosen

camera first if multiple devices are named `UVC Camera`; the generic name alone

does not establish the USB vendor/product identity.

Passing an argument-construction unit test or producing a DMG is not a substitute

for these device tests. Retain the full raw frames and FFmpeg diagnostics when

reporting results so any conversion, padding, or metadata changes can be examined.

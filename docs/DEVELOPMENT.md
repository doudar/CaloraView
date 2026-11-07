# Development notes

## Runtime boundary

Caloraview captures original SK02 detector frames and, on Windows with verified factory files and a valid shutter reference, computes factory-corrected pixels and scene temperatures. Missing calibration, invalid metadata, excessive drift or out-of-range pixels leave temperatures unavailable. Raw evidence and detector statistics remain separate from Celsius results.

Portable algorithms have been compared with the native ARM64 libraries offline. These comparisons do not establish traceable physical accuracy or the entire manufacturer-app state machine. See [factory startup](factory-startup-pipeline.md) and [radiometry](portable-radiometry.md).

The workspace/product is Caloraview. Legacy `accuheat-session-v1` and `accuheat-calibration-export-v1` data identifiers remain compatible, and the supplied `AccuHeat_V1.1.1_Android.apk` retains its evidence filename. Source paths must remain relative to the workspace/application, not tied to an old folder name.

## Components

| Component | Responsibility |
| --- | --- |
| `src/main.cjs` | Source ownership, initialization, processing, shutter lifecycle, IPC and capture sessions |
| `src/preload.cjs` | Narrow action/subscription interface |
| `src/core/capture.cjs` | FFmpeg capture, raw-format verification and raw replay |
| `src/core/calibration-cache.cjs` | Fresh identity, automatic download, validation and persistent cache |
| `src/core/factory-processor.cjs` | Shutter background, selected startup NUC, FPN, BPC, VC and host metadata |
| `src/core/temperature-sampler.cjs` | Anchored2 Hz measurement attempts, held display values and immediate invalidation |
| `src/core/radiometry.cjs` | Actual factory calibration, online preparation, environment conversion and valid temperature statistics |
| `src/core/thermal.cjs` | Original detector statistics, palette and preview leveling |
| `src/core/display-transform.cjs` | Rotation, marker mapping and explicit smooth-display fallback |
| `src/core/neural-worker.cjs` | Validated local model inference outside the capture/measurement loop |
| `src/core/session.cjs` | CSV/raw/video output, reference events and provenance |
| `src/core/controls.cjs` | Windows helper process, shutter events and confirmed reopening |
| `scripts/protocol/` | Windows KS control, exact physical identity binding and factory exporter |
| `src/renderer/` | Preview, progress, temperature/count cards and controls |

Electron enables context isolation, renderer sandboxing and a restrictive content security policy. Renderer Node integration and external navigation are disabled. FFmpeg and the control helper use argument arrays and hidden windows. Frame delivery acknowledgments and encoder queues bound memory growth.

## Raw transport and measurements

The device is SK02/AY1, USB `38be:0184`, serial family `A43EB0`. It advertises 264 × 222 YUY2 at nominal 25 fps, 117,216 bytes per frame. The bytes are little-endian detector words, not ordinary color pixels. Capture uses packet copy and refuses a negotiated format that changes them. Complete transport frames are retained, including metadata beyond the detector crop x4/y2, 256 × 192.

Original count statistics use the cropped raw plane. The center pixel is (128,96); coordinates are zero-based and equal extrema select the first row-major pixel. Factory-temperature extrema are calculated separately after correction and conversion. Their coordinates can differ from raw extrema. CSV keeps both coordinate sets in native detector orientation; rotation/enlargement only maps displayed markers.

The live default sensor/range uses KMatrix2, offset 8192, 16-frame quarter-count shutter background, FPN, isolated BPC and actual VC. The current branch is the native startup fallback, not the later A/B/C drift model. Incoming CAV must be valid. A drift of at least 13 counts requests a fresh shutter reference; invalid frames are excluded while that action proceeds. This is not a claim to implement the native 300-second timed policy or all 17/25-count controller transitions.

The display temperature-unit preference persists between app launches. Celsius remains the calculation basis; Fahrenheit is a display/export conversion. CSV contains both units regardless of that preference.

Application defaults are emissivity 0.91, ambient/reflected 20 C, humidity 60%, and distance 3 ft (0.9144 m). The Parameters dialog edits these values, includes material emissivity presets and feet/meters entry, and persists canonical values between sessions. Parameter changes are locked during recording/logging and initialization; applying changes resets held measurements before the next sample. Provenance preserves requested inputs and the calibration hash. Earlier 0.97 / 1 m native comparisons were explicit test vectors, not current app defaults. See the [environment-stage evidence](radiometry-environment.md) for the corrected SDK meter/Q13 boundary. Any invalid or out-of-range detector temperature suppresses the whole-frame temperature statistics.

## Initialization and shutter handling

Connection verifies identity/cache before capture, reports centered progress, waits for stable frames and automatically runs the verified internal shutter cycle. **Auto calibrate** is the sole manual correction action. There is no uniform-target capture or stored uniform-target mode.

The app collects complete frames 150–1000 ms after the helper's closed event. The factory processor requires at least 16 eligible frames and uses the last 16. It accepts the reference only in the explicit closed-window path and records `nativeControllerEquivalent:false`. The helper releases/reopens the shutter in cleanup, and application shutdown waits for control completion before stopping capture. Reference evidence includes full raw frames and control timestamps/results.

Each new connection acquires a new shutter reference. Factory files persist separately in Electron `userData/camera-calibration`, or `CALORAVIEW_CALIBRATION_DIR`. The cache key combines the verified physical serial with a fresh identity-response hash. Current setup requests VC support and refreshes an older index once; the exporter preserves the VC attempt outcome. This unit's actual VC plane is available. A missing map is not silently replaced in the live processor.

The factory-files card and information banner have been removed; automatic calibration setup remains unchanged. If download or processor setup fails, raw preview may still operate with a visible error and blank temperatures. Windows uses the existing UVC driver through KS; there are no firmware/flash writes or driver replacements. Mac control transport remains unimplemented.

## Display and capture semantics

Native preview is 256 × 192. HD runs normalized grayscale through an ONNX worker before palette mapping: Real-ESRGAN DN50 on a supported GPU, with FSRCNN CPU fallback. Rotation remains available. It uses open-source models rather than the APK's TSR/AI implementation and does not add independent measurements. PNG and MP4 use selected output dimensions/orientation; original detector data, temperature values and CSV coordinates stay native.

Video saves color MP4, complete `sensor.raw`, sampled CSV and session metadata. PNG includes one exact raw frame and JSON measurements. Logging saves CSV and session metadata. Sessions record calibration provenance, configured environment independently of current temperature validity, display geometry and reference changes. Per-frame method/model/provider and source mappings are recorded in `preview-frames.csv`. Shutter evidence is saved separately; the existing preview-reference array may also be retained with captures.

Raw recording retains every received frame at nominal 25 fps. MP4 uses completed previews on a 25 fps timeline, repeating the previous image for missing slots; it does not preserve every distinct raw image. Temperature evaluation is anchored at 2 Hz; CSV independently selects 2, 1, 0.5 or 0.2 Hz fresh attempts. Held display values never create duplicate CSV rows, while fresh invalid attempts produce blank temperature fields. Lower logging rates use anchored deadlines with one camera-frame timing allowance. CSV timestamps identify the sampled frame; sequence and monotonic sample time are explicit. `frames` and `measurementRows` are separate metadata counts.

Environment columns are configured inputs, not measured room conditions: ambient 20°C and relative humidity 60% by default, with Fahrenheit also recorded. Missing/nonfinite values remain blank. `environmentSource` is `configured`. Snapshot metadata retains both image and sample timestamps. Queue overflow stops recording with an error while preserving already written files. Finalization records interruption and errors. Replay runs complete raw frames at the nominal rate with new timestamps; it does not restore factory/shutter state or the original acquisition timeline.

## Build and validation

```sh
npm ci
npm test
npm run test:ui
npm run pack
```

`npm test` is hardware-free; use its current output for the authoritative count. Inspect UI smoke scripts before running them because their hardware modes operate the camera. `node scripts/hardware-smoke.cjs` explicitly captures 75 frames under `test-output/`. The parent integration run owns the camera during live regression.

Use `CALORAVIEW_OUTPUT` for a test capture directory and `CALORAVIEW_FFMPEG` for an explicit FFmpeg executable. Windows build hooks compile `build/native/Caloraview.CameraControl.exe` with the installed .NET Framework compiler; packaged apps include it in `resources/native` and do not compile at runtime. The build hook is a no-op on macOS. Build `dist:win` on Windows and `dist:mac` on a Mac, with platform-specific dependencies. Mac signing/notarization and real-device validation remain outstanding.

Native oracle scripts run inspected ARM64 code only in the local research environment. Their APK libraries, captures, generated vectors and emulator dependencies are not desktop runtime dependencies. `.tools/`, `research/`, APKs, `dist/` and capture output remain ignored. The public repository retains original analysis source and documentation only. Vendor APKs, extracted libraries, captures, local signing keys, emulator dependencies and generated reports were removed for publication. Historical research paths describe private inputs that are not shipped; these scripts are not required to build or test the app.

## Asynchronous preview recording

`Session.append(raw,nativeFrame,{videoFrame:false})` preserves complete raw frames and selected fresh measurement CSV rows before display inference. `appendVideo(enhancedFrame)` accepts only a completed preview whose sequence and source timestamps match a retained raw-frame entry. The 512-entry mapping bounds memory; duplicate,older,before-session and post-close results are ignored. Geometry and nominal preview fps are frozen for the recording.

`preview-frames.csv` maps encoded frame index to source sequence,raw index,capture timestamp,presentation time,repeat flag and bounded model/provider strings. Timestamp-based CFR fills missing slots with the preceding image and its original provenance, never current-frame temperatures. The first accepted preview anchors video start; a gap over two seconds fails instead of producing an unbounded burst. `frames`, `measurementRows`, `videoFrames` and `uniquePreviewFrames` have separate meanings. Raw/CSV rollback and preview-manifest rollback preserve their last complete records independently.

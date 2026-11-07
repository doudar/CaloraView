# Image enhancement investigation

Caloraview's selected HD implementation uses an open-source scalar neural display stage before palette mapping: Real-ESRGAN general-v3 DN50 on a supported GPU, with FSRCNN x2 as a lightweight CPU fallback. Inputs are normalized 256 × 192 grayscale; outputs are 512 × 384. Native view and90° rotation remain available. This is independent of the proprietary Android/iOS algorithms and adds no temperature measurements.

The Real-ESRGAN wrapper interpolates the official strong/weak-denoising weights equally, repeats grayscale to RGB, runs the x4 network, averages its RGB output and downsamples 2× to the requested x2 display. FSRCNN retains its official subpixel weights with a verified ONNX graph conversion. Licenses, upstream hashes and modification records are retained in [model notices](../src/models/NOTICE.md). No vendor APK model is shipped.

The Node ONNX Runtime 1.31.1 Real-ESRGAN benchmark over 45 saved corrected frames averaged 12.27 ms inference, with 14 ms 95th percentile and 15 ms 95th-percentile worker round trip on this host. FSRCNN's Python-runtime comparison measured 15.18 ms median on one CPU thread, 5.65 ms on four, and 0.775 ms using DML. These are different benchmark harnesses, not interchangeable end-to-end live-frame rates. The subsequent Windows source camera regression passed on Real-ESRGAN/DML GPU0: 80 raw frames, 69 unique AI images and 84 CFR video frames, with 6 calibrated measurement rows and zero renderer errors. Raw throughput measured 23.48 Hz in that run. Subsequent Windows packaged checks passed GPU and CPU inference, parameter/restart persistence, and live material/environment metadata. Packaged model inference measured approximately 14 ms on DirectML and 7 ms with the CPU fallback on this host; these are inference timings, not end-to-end capture rates. See [status](STATUS.md) for the evidence path.

Asynchronous enhancement never gates original raw capture or the 2 Hz temperature sampler. Measurement CSV selects fresh samples independently. The app records video on a frozen 25 fps timeline (the session helper also supports 15 fps) and repeats the prior enhanced image for missing slots, recording original source/raw indices, timestamps, model/provider and repeat flags in `preview-frames.csv`. Missing slots are not filled with fabricated measurements. Gaps beyond two seconds stop recording rather than create unbounded duplicates.

The Android and iOS findings below remain historical reverse-engineering evidence, not a claim that these open-source models reproduce either app. Natural-image training can invent or suppress detail; there is no paired high-resolution thermal ground truth validating generated structures.

## Verified Android live path

These findings come from the supplied `AccuHeat_V1.1.1_Android.apk`, with locally decompiled source under `research/decompiled/sources`. They describe Android behavior; they do not establish the implementation of the iOS app.

The connected SK02's module identifier `065356A000` maps to `ModuleType.F2ModuleType.A02F2` in `p089h4/a.java:36`. The device predicates in `Y3/d.java` make this model eligible for the live preview's two-state HD switch:

1. `SensorPreviewFragment.G7` (`:9912`) installs the `H7` click handler for A02F2. `H7` (`:7301`) switches between UI states 1 and 2.
2. `E7` (`:9865`) updates the UIRA-IR control and calls `P3.h.k1`. Its coroutine `C1300u` (`P3/h.java:11902`) converts state 2 to `SRMultipleWrapper.X2` and enables SR. State 1 maps to the unknown multiple and disables SR.
3. `SRStateParamsWrapper` supplies algorithm `ACNN` by default. `P3.h.h2`, the sensor repository, and `UvcAdapter.m160setSRSStateIoAF18A` pass this configuration to `MicroSensorUVC.set`.
4. `MicroSensorDCBase.ConfigHelper` maps it to public `ConfigCommand.SetSRState` (35), dispatched through `MicroSensorDCBaseJNI.set` in `libSJNI`.

This is an active live-preview configuration path for the actual SK02 model, rather than merely an unused library API. Native success and effective output still depend on runtime capability checks. `P3.h.C1299t` queries SR capability and supplies CPU constraints (X2 minimum 10 fps; X4 minimum 20 fps). Another initialization coroutine selects supported state and sets `SemiAuto` SR mode. These constraints are configuration values, not measured camera frame rates.

The exact live model asset, tensor format, temporal state, and complete native execution path remain under investigation. The Java online-SR model-list setter exists, but no application caller assigning live model paths was found in the bounded source search. Do not equate the saved-image models below with the live SK02 model without native evidence.

## Sharpness and presentation

The APK also applies adjustable image enhancement independently of the HD switch. `RulerPickerView` defines sharpness from 0 through 100; `MobileDeviceSettingEntity` defaults to 50. `SensorPreviewFragment` handles the sharpness picker, and `P3/h.java:3095` sends brightness, contrast, and sharpening in a manual `EnhancementParamsWrapper`. The adapter dispatches this as public command 25, `SetEnhancementParams`. This is digital image sharpening, not optical focusing.

The native playback callback in `UvcAdapter` emits processed `FrameData` after successful image/measurement processing, with a separate allowance for shutter-frozen frames. `P3/h.java:2007–2078` takes the native result image's dimensions and NV12 bytes, rotates them 90°, optionally applies visible-light fusion, and constructs `FrameDataResult`. That ordinary thermal path does not perform a separate Java resize to 512 × 384.

The preview surface uses `p305z4.d` and its `p281x4.l` YUV drawer. The drawer configures both texture minification and magnification with `GL_LINEAR` (`p281x4/l.java:177–181`) and clamps edges. This is presentation filtering after native processing. The fragment's per-frame `R5` draw method did not decompile successfully, so its precise call sequence is not reconstructed here. The renderer evidence does not establish that a linear filter alone explains the APK's sharper result.

Generic private SDK focus commands exist, but no actual SK02 optical-focus call was found in the inspected preview/adapter paths. A manual-focus help entry is gated to other module identifiers, excluding this SK02. Do not expose a software “focus” slider based on the sharpening parameter or generic SDK command names.

## Saved-image models and portability

The APK contains these model assets:

- `TSR_V2.1.0_w256_h192_Android_ARM_1dang_build20250709.bin`
- `TSR_V2.1.0_w256_h192_Android_ARM_2dang_build20250709.bin`
- `TSR_Realtime_V1.0.1_192_256_Android_build20240722.bin`
- `TSR_Offline_V2.0.0_192_256_Android_build20240605.bin`

Other 96 × 96 models also exist. `com/hikmicro/offline/OfflineFragment.java:4849` assigns the 256 × 192 pair to `AnalyzerII.setTsrPathx2_1` and `setTsrPathx2_2`; the 96 × 96 models use the x4 setters. The PDF secondary-analysis flow repeats this setup. This establishes a saved-image analysis path, not the live model selection.

The ARM64 `libtsr_v2.0.0.so` exports model creation, initialization, processing, configuration, and release functions, and imports the vendor `HKANN` inference runtime. Portable ONNX/TFLite weights have not been established. An Android ELF library cannot directly serve as a Windows/macOS native module. No vendor enhancement model or inference runtime is shipped with Caloraview.

## iOS visual reference and next steps

The user separately supplied an **iOS** export, `video5150051037880518934.mp4`. Inspection reports a 624 × 832 portrait container at 30 fps, about 17.93 seconds long. These are export properties, not evidence of native sensor resolution, unique thermal-frame rate, or the Android pipeline. Use the clip as a visual quality target while keeping the platform evidence separate.

The implemented open-source enhancement preserves native raw frames and temperature coordinates at 256 × 192, records display provenance, and maps displayed markers without changing measurement coordinates. Establish the vendor model's inputs, normalization, supported runtime, redistribution rights, and moving-scene behavior before claiming equivalence. A portable sharpening implementation must likewise be labeled and tested as image processing; it must not change the calibrated measurement plane.

## Native processing evidence

The ARM64 MicroIA library has separate conventional ISP and neural-SR paths. At `0xe4b54` its loader opens `libtsr_v2.0.0.so` and `libacnn_v2.3.4.so`. Wrappers at `0xe48c0` through `0xe4b3c` dynamically resolve `HIKTSR_GetModelSize`, model creation/initialization, memory sizing, creation, processing, and release. The processing wrapper at `0xe4a78` resolves `HIKTSR_Process`. In the TSR library, `TSR_NET_Process` (`0x1bb0`) builds an inference descriptor, calls `HKANN_Process` (`0x1c64`), and clamps floating output to 0–255 before converting to bytes (`0x1cac` onward). This establishes an actual learned inference implementation; it does not identify the exact model selected by the live ACNN command or prove the iOS app uses that implementation.

`libifrisp.so!IFR_ISP_Process` (`0x125dc`) exposes the conventional processing order, with stages controlled by configuration flags: optional raw enhancement, 14-bit noise reduction, detail separation, AGC tone mapping, detail reinjection, then 8-bit temporal filtering. Calls include `NR_Filter14bit` at `0x12788`, the DDE detail paths at `0x127ac`/`0x127d4`, AGC3/AGC2/AGC4 at `0x12804`/`0x12820`/`0x12840`, `DDE_V3_AddHfDetail` at `0x12868`, and `NR_Filter8bit` at `0x128a0`. MicroIA's synchronous processing path calls the ISP wrapper at `0xbefb8`, additional configured processing, `AGC_RUN` through `0xbf03c`, then its later rendering stages. The complete live branch selection and the exact SR placement relative to all detail/denoise variants remain unresolved; this is a conditional native sequence, not an asserted complete SK02/iOS pipeline.

The manual sharpness route is more precisely established: MicroIA stores `EnhancementParams` at `0xb7c48`, applies those settings during frame processing (`0xbf8fc`), and sends the sharpening field to `IFR_ISP_SetConfig` key **0x302** at `0xf05a0–0xf05c0`. It reaches the ISP strength byte at handle offset `0x2b4`; `DDE_Params_Refresh` at `0x28d0c` turns that strength into a nonlinear Q8 detail gain. Offline native probes of strengths 0, 25, 50, 75, 100 produced gains 0, 128, 256, 640, 1023 respectively. It is a detail-enhancement control, not an optical-focus command.

The MicroDM resource selector at `0x27fc34`, called at `0x20110c`, selects a 966-byte embedded ZIP at `0x101c7cf` for sensor enums 1/2. It contains F2-labeled AGC, DDE, and DNR profiles of 1376, 800, and 536 bytes. The reproducible [offline resource probe](../scripts/research/isp-resource-probe.py) pins both inspected library hashes, extracts only these bounded entries, initializes the native ISP in the local ARM64 emulator, verifies successful configuration calls, and probes the sharpness mapping. Local evidence is saved in `research/isp-reference/configuration.json`. The probe uses synthetic zero ability flags; it establishes parsing and the isolated knob, **not** the complete live active configuration. Neither the extracted vendor data nor the emulator is part of the desktop runtime.

The open-source scalar display stage is the selected practical implementation while the vendor ISP path remains under investigation. This targets smooth surfaces and crisp boundaries without amplifying colored noise. Differential tests against isolated native stages and moving-scene comparisons should precede claiming APK equivalence. Replacing our final RGBA bicubic resize alone cannot reproduce the APK's combined denoise/detail/neural processing.

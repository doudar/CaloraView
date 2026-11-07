# Implementation status

Current implementation targets the AccuMEMS SK02. Windows source and packaged checks have passed, including AI inference, parameter persistence across restart, and live material/environment metadata. Run `npm test` for the current test count; optional historical native-reference tests skip when their private inputs are absent. The live v3 pipeline includes the recovered generated-reference step, automatic initial reflected-temperature estimation with manual override, and no fitted temperature offset. HD/AI is the first-run default and view selection persists. Absolute physical accuracy remains unverified.

The repository is prepared for public distribution under MIT, with original branding and independently licensed display models. APKs, extracted libraries, camera exports, generated reports and local signing keys have been removed. The checkpoints below are historical; paths to those removed outputs are retained only to describe the original experiments. See [release operations](RELEASING.md) for CI and patch tagging.

The v3 packaged live check passed snapshots and six CSV measurement rows; the portable build completed.

## Current parameters and packaged checks

The Parameters dialog supports material presets or custom emissivity, camera-to-target distance in feet/meters, air/reflected temperature in the selected C/F unit, and relative humidity. Initial values are emissivity 0.91, 3 ft (0.9144 m), air/reflected 20 C and RH 60%. Values persist across restart; changing only material or display units preserves exact stored Celsius/meters. Invalid inputs leave preferences unchanged. Recording/logging and initialization lock parameter changes.

Packaged restart integration verified Paint 0.93, 10 ft stored as 3.048 m, C/F changes retaining all parameters, invalid-input rejection and exact readback, with zero renderer errors. Evidence is `test-output/parameters-integration-8FfF7W/`. Packaged GPU/CPU model checks passed, with inference approximately 14 ms on DirectML and 7 ms using the CPU fallback on this host. A live material/parameter check also verified measurement metadata. These timings do not establish complete capture throughput or recovered thermal detail.

Session JSON now stores configured measurement parameters independently of temporary temperature availability. Per-frame display method/model/provider belongs to `preview-frames.csv`; session JSON retains display geometry and calibration/reference provenance. Raw frames and measurement sampling stay independent of enhancement.

| Capability | Status |
| --- | --- |
| Raw USB stream | Windows capture verified, 264 × 222 at nominal 25 fps; detector crop x4/y2, 256 × 192 |
| Factory data | Actual BPM, KMatrix, KMatrix2, thermometry and VC obtained directly on Windows; the first four match the Android export |
| Persistent calibration | Serial and fresh-device-identity binding; automatic first-connect download and cache reuse; older cache refreshed for VC-table support |
| Initialization | Centered progress through identity/cache, stream startup and automatic internal shutter reference |
| Factory startup correction | Live module implemented; native 16-frame acquisition → NUC → FPN → BPC → VC matches 245,760 own-capture pixels with VC history retained |
| Portable scene radiometry | Actual camera calibration, generated-reference v3, metadata preparation, float-online conversion and manual environmental compensation; native numerical comparisons completed |
| Editable measurement parameters | Material/custom emissivity, feet/meters, air/reflected temperature and RH; persisted and recorded |
| Center/high/low display and CSV | Implemented; invalid frames stay blank; raw detector counts and separate temperature-extrema coordinates retained |
| Auto calibrate | Single internal-shutter action; uniform-target controls removed |
| Drift refresh | Supported startup branch requests a new reference at 13 CAV counts; complete native timed/A/B/C controller remains unported |
| Native/HD preview | Native 256 × 192 or open-source neural 512 × 384: Real-ESRGAN DN50 GPU/FSRCNN CPU fallback; Real-ESRGAN DML GPU0 verified live |
| Rotation | 90° steps for preview/export; raw data and CSV coordinates retain native detector orientation |
| PNG/MP4/raw/CSV | Integrated source run verified snapshots, portrait 384 × 512 MP4, raw and CSV logging |
| Replay | Raw replay verified; original calibration/shutter state is not automatically restored |
| Physical temperature accuracy | Not established against a traceable target |
| macOS | Portable processing and build configuration present; no Mac hardware validation; factory/shutter control transport is Windows-only |

## Validation checkpoints

The subsequent actual DDAC diagnostic matched 1,228,800 native corrected pixels across 25 scene frames. Its generated-reference/temperature replay matched 75 native center/high/low values exactly under the supplied settings. Provenance remains experimental with `absoluteAccuracyValidated:false`; the app does not claim a traceable physical calibration from numerical agreement.

The full factory startup chain has matched the native library on five saved scene frames, 245,760 pixels, with this unit's actual calibration and 16 own shutter frames. Native invalid/drift flags are zero for those inputs. Independent FPA checks match 118 cases. Individual FPN, BPC, VC and radiometry tests cover further synthetic and captured inputs. Generated evidence remains in ignored `research/`.

The earlier packaged Windows checkpoint verified connection, calibration download, shutter, PNG, 48-frame MP4/raw/CSV recording, standalone logging and replay without renderer errors. A separate restart check verified serial/identity-matched cache reuse. An earlier source integration run verified automatic initialization and shutter, manual Auto calibrate, native/HD switching, 90° rotation in both directions, portrait 384 × 512 video, snapshot, standalone logging and replay with zero renderer errors. All 45 recorded CSV rows contained valid factory-calibrated numeric temperatures. Local evidence is `test-output/ui/2026-11-07T17-07-28-578Z-recording-KLzAUw`. The subsequent full `npm test` run passed **124 tests, zero failures, zero skips**, including the persisted C/F preference and both-unit CSV changes. The preceding portable build completed. Sampling/logging changes were added afterward; that checkpoint passed **137 tests, zero failures, zero skips**, and the subsequent source live regression passed, and the earlier 45-row result describes the earlier per-frame CSV implementation. Those earlier source results are separate from the current packaged checks above.

The runtime uses the connected unit's factory files; no calibration from the APK's sample fixture is substituted. Temperature provenance records the algorithm, calibration hash, camera serial, environmental assumptions and `absoluteAccuracyValidated:false`. Numerical agreement with the native algorithm is distinct from physical accuracy or complete manufacturer-app state equivalence.

## Evidence and remaining work

- [Factory startup pipeline](factory-startup-pipeline.md): selected default gear, first-reference fallback, full-chain comparison and eligibility limits.

- [Portable radiometry](portable-radiometry.md), [environment stage](radiometry-environment.md), and [actual SK02 reference](actual-sk02-radiometry-reference.md): temperature calculation and native comparisons.

- [USB protocol](protocol-investigation.md) and [platform controls](platform-control-options.md): successful direct-length transfers, prior failed sizing-path diagnostics and control boundaries.

- [NUC](nuc-investigation.md), [shutter background](shutter-background-investigation.md), and [VC](vignetting-investigation.md): factory corrections and remaining controller state.

- [Host metadata](host-metadata-normalization.md) and [frame metadata](frame-metadata-investigation.md): FPA/CAV and validity fields.

- [Calibration validation](calibration-export-validation.md) and [Android helper](../tools/android-calibration-export/README.md): export contracts and the verified fallback path.

- [Image enhancement](enhancement-roadmap.md): selected open-source neural display models versus unresolved proprietary paths.

- [Mac validation](MACOS.md): real-device and control work still required.

Research is not complete, and local reverse-engineering evidence has not been cleaned up. Full later drift/gear/controller behavior, warm-up and long-duration comparisons, physical reference-target accuracy and Mac hardware/control validation remain separate work. No driver replacement, factory reset or factory-calibration write was used.

Source APK: `AccuHeat_V1.1.1_Android.apk`, SHA-256 `ab49a52d1b2a7c42caf51fdee6b8067f3090ac86d196998eafba8aa14f517ec0`. The original filename and legacy data-schema identifiers are retained as provenance/compatibility, not current branding.

## Sampled logging live checkpoint

The source app passed the updated Windows SK02 workflow: 77 raw/video frames and 7 valid factory-calibrated CSV rows over approximately 3.2 seconds at 2 Hz. Standalone 1 Hz logging produced 2–3 rows over 2.3 seconds. Configured environment columns contained 20°C, 68°F and 60% RH; zero renderer errors occurred. Evidence is `test-output/ui/2026-11-07T17-25-59-952Z-recording-b0GkWl`. That checkpoint passed 137 tests with no failures or skips. The updated source app was reopened for the user's test; the updated Windows portable build then completed successfully (`dist/Caloraview Desktop 0.1.0.exe`, 131,594,325 bytes). That checkpoint predates the current packaged checks above.

## AI integration checkpoint

The selected display stage is Real-ESRGAN general-v3 DN50 for GPU inference and FSRCNN x2 for CPU fallback. Model licenses and source/derived hashes are retained under `src/models/`. Both operate on normalized grayscale before palette mapping; raw capture and native temperature calculations remain independent. Video now records source mappings and explicit held-image repetitions instead of speeding playback when enhancement updates arrive more slowly.

Node ONNX Runtime 1.31.1 evaluated 45 corrected frames at 12.27 ms mean inference, with 14 ms 95th percentile and 15 ms 95th-percentile worker round trip on this host. FSRCNN conversion was independently compared with its original TensorFlow PB over 4,718,592 values, with maximum normalized difference 1.20e-5. These benchmarks do not establish thermal detail recovery, physical accuracy or final live throughput. The AI-integrated source camera regression and 153-test suite subsequently passed as described below. The earlier portable-build checkpoint predates AI integration; subsequent packaged checks are summarized above.

### AI source hardware result

The Windows SK02 source app passed with Real-ESRGAN on DirectML GPU0: **80 raw frames, 69 unique AI preview images, 84 CFR encoded video frames and 6 valid factory-calibrated CSV rows**. Measured raw throughput was **23.48 Hz** during this run; the requested capture rate remains 25 fps. Missing preview timing slots reused the prior image with explicit source mappings, so encoded and raw frame counts intentionally differ. No renderer errors occurred. The immediate rotation-to-record regression also passed. Evidence is `test-output/ui/2026-11-07T17-52-20-377Z-recording-BAsMXg`.

That source checkpoint passed **153 tests, zero failures, zero skips**. The in-image mode label has since been removed, and subsequent packaged checks passed as summarized above. None of these checks establishes traceable physical temperature accuracy.

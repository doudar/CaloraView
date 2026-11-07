# Native NUC investigation

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

Current integration checkpoint: the selected default gear 3 startup branch,16-frame shutter acquisition, actual KMatrix2/BPM/VC, FPN and normalized metadata are now composed in the live factory processor. The complete correction chain matches 245,760 pixels against native processing on own saved inputs. The later ready-state TECLESS30 drift model below remains a separate offline helper. See [factory startup pipeline](factory-startup-pipeline.md) for the implemented boundary and [status](STATUS.md) for live validation.

Evidence is from the ARM64 `libifrnuc.so` inside the supplied AccuHeat APK, disassembled locally with Android NDK 29 LLVM tools. Addresses below are ELF virtual addresses in this specific binary, not portable API constants. The extracted binary and full disassembly remain under ignored `research/`. This document records verified arithmetic separately from unresolved device integration.

## Current boundary

`src/core/nuc.cjs` and `src/core/nuc-tecless.cjs` are **offline research helpers**. Nothing in the live application imports or enables them. The former reproduces the simple scalar branch; the latter now reproduces the enabled TECLESS30 per-pixel drift branch with explicitly supplied state. Neither is a complete SK02 calibration pipeline or calculates Celsius. Factory table layout, background construction, compensation state, and runtime overrides still require verification against device data.

Six tests in `test/nuc.test.cjs` cover identity gain, nonuniform maps, negative arithmetic shifts, clipping, signed 32-bit overflow, typed-array views, input validation, and preservation of inputs. The overflow expectations use an independent BigInt reference calculation.

## Verified correction arithmetic

`NUC_Process` begins at `0x1ef30`. For its ordinary gain branch, scalar instructions at `0x1f13c–0x1f168` load unsigned 16-bit raw, background, and gain samples, then calculate:

```text

d = (raw << 2) - background

p = signed32(d * gain)                  // wrap at 32 bits

corrected = clamp(offset + (p ASR 17), 0, 16383)

```

`offset` is the unsigned 16-bit value at handle offset `0xde`, loaded at `0x1ef88`. `ASR` is an arithmetic right shift, so negative fractions round down. A wide floating-point multiplication followed by division is not equivalent at overflow boundaries. The JavaScript implementation uses `Math.imul` and `>> 17` to preserve these native operations.

This arithmetic implies a Q15 gain (`32768` is unity) and a background with four units per raw detector count. Ignoring overflow and integer rounding, its interpretation is `offset + (raw - background / 4) * gain / 32768`. These units describe detector counts, not temperature.

The gain-bypass branch at `0x1f030–0x1f058` substitutes a left shift of 15 for multiplication, consistent with unity gain. An optional additional upper limiter uses flag `handle+0x1a5` and limit `handle+0x1a8` at `0x1f16c–0x1f184`; the helper represents the branch with this limiter disabled.

The selected mode is a byte at `handle+0xea`. Mode 0 uses the simple path; mode 1 calls `NUC_TECLESS30_Process` (`0x1f1ec`); modes 3 and 4 call `NUC_SHUTLESS_Process`. TECLESS30 contains the same final arithmetic in several branches (for example `0x205e4–0x2061c` and `0x1fb84–0x1fbb4`) but also additional temperature and shutter compensation. The embedded F2 resource selects mode 1. Matching its final arithmetic does not establish that the simple helper is sufficient for SK02.

## Input pointers and processing order

`IFR_NUC_Process` starts at `0x1d594`. Its arguments include the NUC handle, image structure, realtime structure, and feedback structure. At `0x1def0–0x1df10`, the call to `NUC_Process` passes:

| Input | Source |

| --- | --- |

| Pixel buffer | image structure + `0x10` |

| Background pointer | realtime structure + `0x78` |

| Gain pointer | realtime structure + `0x80` |

| Additional sensor value | handle + `0x1e` |

Enabled downstream operations occur in this order: NUC, FPN correction (`0x1df6c`), bad-pixel correction (`0x1df98`), then vignetting correction (`0x1dfb4`). Module-mask flags gate individual operations. The background is runtime state; the existence of a factory K matrix does not establish how to construct the background from an arbitrary scene frame. A scene captured without a uniform shutter target would imprint scene structure into a naive correction.

## TECLESS30 drift compensation, verified offline

The additional enabled branch at `0x1f71c–0x1f820` uses three per-pixel inputs beyond raw counts: unsigned Q15 gain `K`, unsigned quarter-count background `B`, and a **signed16** drift map `P`. The gain is argument2 and background argument3 to `NUC_TECLESS30_Process`; its nine-argument ABI includes a final flag pointer on the stack. The function modifies raw pixels in place.

The verified normal-gain, no-secondary-limiter arithmetic is:

```text

D = filteredSensor - shutterSensorBaseline

G = signed16(unsigned32(signed32(D * (meanP - backgroundSlope))) >> 11)

    // G is instead zero when handle+0x111 is nonzero

driftProduct = signed32((D << 2) * P[i])

wideDifference = (uint64(raw[i]) << 13) - (uint64(B[i]) << 11)

                 - signed64(driftProduct)

corrected[i] = clamp(offset + G + ((wideDifference * K[i]) ASR 28), 0, 16383)

```

`wideDifference` and its multiplication are signed64; `D * P[i]` and the global product first wrap at32 bits. The global shift is logical before sign-extending its low16 bits. These details are visible at `0x1f728–0x1f75c` and `0x1f7f0–0x1f820`. In the validated input domains the wide product cannot overflow signed64. This differs materially from the simple mode0 helper, whose final multiply wraps at32 bits.

Ignoring rounding and wrapping, the per-pixel correction subtracts `D * P[i] / 2048` detector counts before applying gain. Thus the signed drift map is Q11 detector counts per sensor unit; `D` uses the internal sensor scale, not scene Celsius. The global term compensates the difference between the mean pixel drift and the separately tracked image-background drift.

`src/core/nuc-tecless.cjs` exports `applyTecLess30`. It requires every map and scalar explicitly, validates their integer ranges and typed-array types, and returns a new `Uint16Array`. It deliberately does not select gears, average shutter frames, filter sensor metadata, handle gain bypass, or apply the optional secondary upper limiter. It is not imported by the live app.

### Selected state and source evidence

| State | Location | Evidence/use |

| --- | --- | --- |

| Drift compensation enable | byte `+0xec` | Initialized to1 at `0x1a2c4`; setter index531 writes it at `0x1bcd4`; branch checked at `0x1f70c` |

| Per-gear shutter-ready flags | bytes `+0xf0`, `+0xf1`, `+0xf2` | Checked with captured gear `+0x610` and captured type `+0x611==1` at `0x1f4d0–0x1f5b4` |

| Drift map, gears1/2/3 | pointers `+0x668`, `+0x670`, `+0x678` | Signed16 loads in the correction loop |

| Mean drift, gears1/2/3 | signed16 `+0x68a`, `+0x68e`, `+0x692` | First per-gear scalar in global term |

| Background slope, gears1/2/3 | signed16 `+0x68c`, `+0x690`, `+0x694` | Second per-gear scalar in global term |

| Shutter sensor baseline | signed16 `+0x69c` | Subtracted from filtered sensor at `0x1f720–0x1f730` |

| Sensor history | pointer `+0x150`, count byte `+0xf5` |32 signed16 samples; described below |

| Global compensation disable | byte `+0x111` | Zero enables global term; F2 record+6 is zero and UpdateNucParams copies it here |

The F2 resource selects correction mode1, and generic initialization enables `+0xec`. A subsequent runtime parameter531 override remains possible; the resource alone does not prove the live effective value. The processor only takes the drift branch after the selected ready/gear/type checks. Before that, separate background-acquisition and fallback branches execute. Fabricating ready flags in the app would be incorrect; the oracle sets them solely to exercise synthetic arithmetic.

The sensor filter has an initial fill phase. Before32 samples, a change of at least21 internal units from the preceding accepted sample is replaced by that preceding sample (`0x1f268–0x1f294`). At32 samples it averages all signed16 values, truncating division by32 toward zero (`0x1f414–0x1f4cc`). Once full, the count saturates at33, the32-entry history shifts, the current sample is appended, and the same average is calculated. The steady-state branch does not repeat that initial-fill outlier check. The pure helper accepts the already filtered difference, so this history must be reproduced separately before live use.

### How the drift state is constructed

The map is not merely another interpretation of the downloaded KMatrix. `IFR_NUC_Cali_BCaliCalcBMatrix` constructs it from two stored background image planes at pointers `+0x650` and `+0x658`, associated with sensor states `+0x696` and `+0x698`. When its acquisition state `+0xed` is2 or3 and gear/type selection is valid, it computes:

```text

P[i] = signed16(truncToInt32(float32((second[i] - first[i])

                                    / (secondSensor - firstSensor)) * 2048))

```

The scalar evidence is `0x21ff4–0x22020`; the vector path at `0x21f18–0x21fb4` uses equivalent float32 division and fixed-point conversion. Native float-to-integer overflow/NaN behavior needs explicit handling before porting this constructor. The function also derives an image-wide mean of these signed16 entries and stores it in the selected mean-drift field (`0x22024–0x22124`). Its averaging uses a Q32 reciprocal and rounding steps, so ordinary floating mean is not automatically bit-equivalent.

Separately, the background slope comes from two shutter image means `+0x682/+0x684` and their sensor readings `+0x686/+0x688`: their mean-count difference divided by sensor difference, converted to Q11 and stored as signed16 (`0x21d5c–0x21dfc`). State logic advances these background reference pairs when sensor change is at least48 internal units (`0x21cac–0x21d30`). This is separate from the17/25 automatic shutter-trigger thresholds.

The current background plane itself is generated from accumulated shutter pixels at `+0x620`. The scalar branch divides the unsigned accumulation by `handle+0x60a >> 2` and writes uint16 (`0x21a78–0x21a94`), consistent with the quarter-count scale used by correction. The F2 resource's first byte is16. The complete acquisition timing, accepted-frame count, frame freezing/copy phases, and map initialization still require a full state-machine port and validation against this device. A standalone flat-field average is not sufficient evidence to replace them.

### Verification and reproducibility

`scripts/research/nuc-tecless-oracle.py` loads the inspected ARM64 library using the research-only Unicorn installation, creates synthetic raw/gain/background/drift maps and synthetic state, and calls the native function. It verifies the library SHA-256 before using these build-specific layouts. It does not contact the camera and embeds no factory data.

With deterministic seed20261107, **35 cases /595 pixels** matched the independent integer formula exactly, including negative sensor differences, signed map values,32-bit wrapping,16-bit global truncation, clipping, and both global-compensation settings. The JavaScript helper separately matched every generated native output. The five Node tests cover readable arithmetic cases, wide products, negative fractional shifts, input validation and views, and independent BigInt overflow expectations.

```powershell

python scripts/research/nuc-tecless-oracle.py

node scripts/research/check-nuc-vectors.cjs

node --test test/nuc-tecless.test.cjs

```

The emulator requires the locally extracted `research/decompiled/resources/lib/arm64-v8a/libifrnuc.so` and the ignored Python dependencies described in `radiometry-investigation.md`. Synthetic reference vectors are written only under ignored `research/`. No live pipeline or hardware behavior was changed.

The actual camera's gain/BPM and thermometry data have now been retrieved, as recorded below. Remaining prerequisites are the VC path, correctly aligned image and metadata planes, faithful shutter accumulation/history/gear transitions, construction of drift maps and their mean slopes, and validation of the enabled downstream FPN/BPC/VC operations. The pixel equation is established for this branch; the complete device processing pipeline is not yet established.

## Gain generation and bad pixels

`IFR_NUC_Cali_KCaliCalcKMatrix` (`0x20b04`) consumes two averaged target arrays at handle offsets `0x6a8` and `0x6b0`. One branch calculates each target's image-wide integer mean and uses the difference of those means (`0x20e50–0x20e68`). Its scalar per-pixel branch at `0x20fac–0x20fe0` divides the mean difference by `(high[i] - low[i] + 0.01)`, converts the ratio to unsigned Q15, and clamps it. The double constant at ELF address `0x377e8` is `0.01`.

The default gain clamp is 25000–45000; a flag at `handle+0xdc` changes it to 16384–65535 (`0x20b3c–0x20b64`). Another branch uses supplied target means at `handle+0x6a4` and `handle+0x6a0`, integer arithmetic, and a zero-difference special case (`0x20ff0–0x21024`). These branches should not be merged into a single claimed factory algorithm without determining the selected configuration.

`IFR_NUC_BPC_ParkagePixel` (`0xa5bc`, spelling as exported) reads three uint16 arrays at input offsets `0`, `0x1000`, and `0x2000`. Its scalar loop at `0xa678–0xa694` forms a uint32 record:

```text

packed = (first << 12) + (third << 24) + second

```

This is evidence of two 12-bit fields and a high field, but coordinate names and on-device serialization remain unverified. Do not assume this is the USB BPM file format. `IFR_NUC_BPC_DecompressPixelInfo` (`0x9e48`) instead copies internal coordinate arrays to this working layout. `NUC_BPC_Process` (`0x9dc8`) populates its working bad-pixel list from stored lists when necessary, then calls `NUC_BPC_DoBPCompensationByMask` (`0x9c24`). Neighbor selection and edge behavior have not yet been ported.

The separate transport investigation identifies download types 4 (BPM), 5 (VC), 11 (KMatrix), and 14 (KMatrix2). A 256 × 192 uint16 gain plane occupies 98,304 bytes. This size is a structural check, not proof of the retrieved table's ordering or encoding. See `protocol-investigation.md` for transport evidence.

## Actual SK02 factory files

On November 7, the Android helper retrieved the files from serial `A43EB0_EXAMPLE`; strict export validation passed. A subsequent direct-length Windows transfer retrieved byte-identical datasets. The original Android files and transaction trace were previously stored under ignored `research/sk02-device-export-20261107/files/`; no factory bytes are embedded in the application or this document.

Interpreting each gain file as 49,152 little-endian uint16 entries gives:

| File | Bytes | Minimum | Maximum | Arithmetic mean | Median | SHA-256 |

| --- | --- | --- | --- | --- | --- | --- |

| KMatrix | 98,304 | 30,275 | 37,077 | 32,827.9142 | 32,783 | `9c9e91129efe685858e77709917c36b27b2027b0bcc3ca3e4e18dccb30b704e1` |

| KMatrix2 | 98,304 | 30,244 | 45,000 | 32,823.7347 | 32,785 | `ba0b216b40f588052bfdf4c832d4d37b5ab30cda034fe8451c54fc73064cae51` |

Neither file contains a zero entry. Their size, distribution near unity 32,768, and KMatrix2 maximum at the native default clamp 45,000 support the Q15-gain interpretation established by the native arithmetic. These statistics alone do not prove orientation or which gain plane each runtime gear selects. Preserve ordering until the native selection/copy path is traced; do not transpose based on an enhanced or rotated display image.

The BPM file is eight bytes (SHA-256 `6db2f2a22354e32eb2f0cf91ca02995ccd63c3e00c9c07022a6872197d66bbe0`), which fits two 32-bit records. Further native evidence now establishes the **internal** record format: `IFR_NUC_Cali_BPC_BPList2BPCaliMask` at `0xfc00–0xfc38` reads uint32 records, extracts bits 12–23 for row and bits 0–11 for column, and checks `(coordinate - 1)` against image height/width. Internal coordinates are therefore one-based. Zero and `0xffffffff` terminate the scan; the maximum scan length is 2,048 records (`0xfc9c–0xfca8`). The top byte is not used by this input loop.

MicroDM downloads file type 4 directly into its cache block at `+0xce8` (`0x201ec0–0x201ed4`). Its AY1 vtable at `0x2bc120`, slot `+0x2f8`, resolves to `readDownloadBlock` at `0x208bf0`. Type 4 allocates a **16,384-byte** buffer (`0x208f24–0x208f30`) and zeroes it (`0x208f58–0x208f64`) before downloading. The SDK receives a copy of the 1,552-byte transfer descriptor: HCUSBSDK `CUsbCommandDownload` copies it into its own `+0x18` at `0x3720dc–0x3720e8`, without retaining the caller descriptor pointer. Announced length is stored separately at command `+0x10` (`0x3728c8–0x3728d4`), checked against capacity `+0x220`, and supplied to the transfer (`0x372348–0x372364`). It does not replace the caller capacity. MicroDM then allocates and copies that full capacity unchanged at `0x209284–0x20929c`. Thus the short two-record device payload is followed by a zero sentinel in the working buffer.

The following `0x203054` call saves a diagnostic copy through `DebugTool::saveFile` (`0x203210–0x203220`). Cache-copy routine `0x2039b4` copies that third shared block into a static-parameter bundle, and `0x2305bc–0x2305e0` copies its bytes into NUC processor block `+0xa8`; `0x2307a8–0x2307ac` passes that block to the native BPM parser. These paths copy bytes without coordinate repacking. Retain the original eight-byte file for provenance, and create a separate zero-padded working buffer when calling the native parser; never pass only an eight-byte allocation to its sentinel-based scan.

This traced copy chain and parser establish zero-based working-image coordinates **`(170, 0)` and `(13, 77)`** for the two downloaded records. They are isolated: neither is in the other's neighbor search. No live bad-pixel replacement has been enabled yet. Their coordinates apply to the native unrotated working image; later display rotations are a separate transform.

### Isolated bad-pixel replacement

`NUC_BPC_DoBPCompensationByMask` (`0x9c24`) first marks all bad pixels in a width × height mask. With the diagnostic marking flag `handle+0x3e8` clear, it visits the list in order and calls `BPC_GetNereastGoodPixel_1` (`0x90f8`) followed by `NUC_BPC_MinGradCompensate` (`0x95b4`). Replacement is in-place, so list order can matter for clustered defects. The diagnostic flag instead writes 16,383 at the bad point (`0x9cfc–0x9d18`).

For an isolated pixel with good surrounding pixels, the sample order is NW, W, SW, S, SE, E, NE, N. Out-of-image samples are zero and marked unavailable. Four gradients pair opposite samples: NW/SE, W/E, SW/NE, and S/N. A pair with either sample unavailable receives gradient 16,383; otherwise its gradient is the absolute difference. The replacement is the integer floor of the average of both endpoints of **every pair tied for the minimum gradient** (`0x974c–0x97f4`). Ties are averaged together rather than choosing the first direction.

There is a separate zero-value fallback, which counts zero sample values rather than unavailable flags: when more than three of the eight sample values equal zero, the native result is `trunc(float32(sum / float32(nonzeroCount + 2^-23)))` (`0x96d4–0x9744`; epsilon at ELF `0x37610`). Legitimate zero detector counts participate in this condition. This is not equivalent to always taking a simple integer mean or ignoring only out-of-bounds neighbors.

At the actual top-row defect, the three northern samples are unavailable. With nonzero good neighbors and ordinary 14-bit gradients, W/E is the only valid opposite pair and yields its integer average; the zero-value fallback can still change that behavior. At the interior defect all four pair directions participate. The native neighbor finder additionally searches out to four positions in certain directions when the bad-pixel mask blocks a neighbor; that clustered-defect search is not ported or claimed covered by this isolated-pixel result.

The reproducible research script `scripts/research/bpc-isolated-oracle.py` loads the same hash-verified ARM64 library and checks **48 synthetic frames / 96 corrected pixels** at isolated top-edge and interior locations against the formula. All outputs matched, including equal-gradient ties, all-zero frames and sparse zero-valued neighbors. It requires the existing ignored Python research dependencies, contacts no hardware, embeds no device calibration, and writes its report only to ignored `research/bpc-isolated-reference.json`. Run `python scripts/research/bpc-isolated-oracle.py` from the repository root. No production helper or live processing changed.

### Next live-preview prerequisites

The gain planes can now be supplied to an **offline** correction comparison. Start with an original cropped detector plane and an actual captured shutter reference from the same camera/gear, keep the original values, and label any gain-plus-reference visualization as partial correction. The F2 TECLESS30 background uses quarter-count units; converting the existing float average without reproducing accepted-frame selection and integer accumulation is not a proven native equivalent. A zero sensor delta only validates the immediate shutter baseline case; it does not remove the need for drift maps, filtered sensor history and subsequent state transitions.

Before enabling a vendor-equivalent live preview, verify gain-plane selection/orientation, BPM allocation and replacement behavior, active gear/offset, shutter accumulation and settling, drift-map initialization, and downstream FPN/VC modules. No separate VC file was included in the successful four-dataset export. The SDK has a fallback VC path around `0x201e78–0x201eac`; determine its selected parameters rather than silently assuming a missing table is unity. Radiometry additionally needs the correct post-NUC metadata rewrite and actual thermometry calibration. Obtaining the files resolves the transport prerequisite; it does not by itself establish scene temperatures.

## Shutter scheduling parameters

`IFR_NUC_SetParam` (`0x1b23c`) consumes an index/value pair. Its jump table at `0x37a50` maps the following indices:

| Index | Handler | Destination | Meaning established by use |

| --- | --- | --- | --- |

| 26 | `0x1b764` | byte `handle+0x11d` | Time-trigger enable |

| 27 | `0x1b780` | byte `handle+0x11e` | Temperature-trigger enable |

| 28 | `0x1b79c` | uint16 `handle+0x120` | Interval in seconds |

| 29 | `0x1b7b8` | byte `handle+0x123` | Configured temperature threshold |

| 30 | `0x1b7d4` | byte `handle+0x124` | Shutter/controller mode field |

| 31 | `0x1b7f0` | byte `handle+0x125` | Additional mode field, not fully traced |

In particular, indices 26 and 27 are enables, not threshold values. MicroDM's auto-calibration settings use those indices through `IFR_NUC_SetConfig`; the command investigation records the call sites.

Two distinct controllers exist. `IFR_NUC_Process` examines the module mask at handle offset `0x40`: bit 22 selects `NUC_ShutterCtrl` (call at `0x1d80c`) when the mode at `+0x124` is 1 or 2. Otherwise bit 23 permits the alternate path that calls `ASIC_ShutterCtrl` at `0x1dddc`. The SDK's embedded F2 resource sets bit 22 and its constructor sets `+0x124` to 1, selecting the host controller unless a subsequent runtime override changes these values.

### Host NUC controller

`NUC_ShutterCtrl` begins at `0x22158`. At `0x2230c–0x22328` it calculates the absolute difference between signed 16-bit `handle+0x1e` and baseline `handle+0x6d8`, and elapsed seconds since a baseline at `handle+0x6c0`. Time originates in `nuc_steady_time_ns` and is divided by one billion.

One explicit trigger branch (`0x22b00–0x22b38`) accepts a temperature delta **greater than or equal to** active byte threshold `handle+0x122` when temperature-enable equals 1, or elapsed time **greater than or equal to** interval `handle+0x120` when time-enable equals 1. The elapsed comparison sign-extends its low 16 bits. Other state flags gate this branch and control subsequent shutter phases; copying just these comparisons is not a complete state machine.

### ASIC controller

`ASIC_ShutterCtrl` begins at `0x7e24`. At `0x7e5c` it converts signed 16-bit `handle+0x1e` by dividing by 50. Depending on `handle+0x754`, it applies `Temp_Filter` before comparison. At `0x847c` it divides active threshold `handle+0x122` by 50 and compares absolute change against its baseline. The trigger is **strictly greater than** threshold and requires the temperature-enable flag; it calls `ShutterVtempControl` at `0x8508`.

The alternative timed branch at `0x8558–0x8574` compares elapsed whole seconds **strictly greater than** `handle+0x120`, requires time-enable, and calls `ShutterTimeControl`. The latter refreshes its time baseline around `0x74b0`. These differences from the host controller matter when reproducing boundary timing.

The factor of 50 establishes internal sensor-temperature scale, but assigning Celsius to the metadata field still requires tracing the incoming device metadata. It is not scene temperature.

### Defaults and gear overrides

Generic `IFR_NUC_InitSpec` (`0x1a174`) initializes offset 5000, correction mode 0, interval 600 seconds, configured and active thresholds 50, and both trigger enables to 1. These are **library defaults, not established SK02 defaults**.

`IFR_NUC_UpdateNucParams` selects a per-gear structure through handle pointers `0x6e8`, `0x6f0`, and `0x6f8`. Fields overwrite correction mode (structure +1), offset (+6), interval (+8), and configured threshold (+0xa). Device-supplied resources can therefore replace the generic values.

`NUC_ShutterConfig` (`0x255a4`), also substantially inlined in the host controller, may replace the active threshold: it uses 17 in one enabled operating state and 25 in certain gear/state combinations. When its dynamic behavior is disabled it copies configured threshold `+0x123` to active threshold `+0x122`. Additional flags allow a configured override. In the ASIC scaled path those values represent 0.34 and 0.5 internal temperature units. They are not enough to claim a fixed universal auto-shutter threshold.

## Embedded F2 resource and constructor overrides

Further tracing in `libMicroDM_Release_v8a.so` establishes a more specific source than the generic library defaults. At `0x226fc4–0x226ff0`, the NUC processor constructor passes its sensor enum to a resource selector at `0x27fbf4` and copies the result. The selector maps enum 0 to ELF VA `0x101c050`, and enums 1 and 2 to VA `0x101c690`; each resource is 319 bytes. The corresponding file offsets subtract `0x8000`, according to this ELF's third LOAD segment. These are built-in SDK configuration resources, not per-device gain calibration planes.

The constructor calls `IFR_NUC_GetNucCapInfo` on that copy (`0x226ffc`), uses the capability result in `IFR_NUC_Create` (`0x227b18`), then calls `IFR_NUC_SetConfig` with type 3 and the same resource (`0x227d4c–0x227d60`). Type 3 dispatches to `IFR_NUC_SetDefaultParam`, which calls `IFR_NUC_LoadParam` and `IFR_NUC_UpdateParams`.

Both resources begin with `NUC`, version fields 1 and 4, and a little-endian uint64 module mask at resource offset `0x17` equal to **`0x1551111`**. `IFR_NUC_GetNucCapInfo` reads this mask at `0x1e09c–0x1e100`; `IFR_NUC_InitSpec` installs the capability mask at handle offset `0x40` (`0x1a21c–0x1a22c`). Set bits are 0, 4, 8, 12, 16, 18, 20, **22**, and 24. Bit 23 is clear.

`IFR_NUC_LoadParam` calculates the payload start as `31 + 4 * popcount(mask)` (`0x1e9fc–0x1ea18`). Here it is offset 67. `IFR_NUC_LoadNUCParams` reads three 28-byte gear records. For each record, mode is byte +2, output offset is uint16 +10, interval is uint16 +12, and configured threshold is byte +14. For the enum 1/2 resource (the raw-layout F2 selector and processor sensor enum must not be assumed to be the same enum domain):

| Gear | Correction mode | Offset, detector counts | Interval, seconds | Configured sensor delta |

| --- | --- | --- | --- | --- |

| 1 | 1, TECLESS30 | 5500 | 300 | 25 |

| 2 | 1, TECLESS30 | 2500 | 300 | 25 |

| 3 | 1, TECLESS30 | 8192 | 300 | 25 |

The enum 0 resource has mode 0 for all three gears, with the same offsets, intervals, and thresholds. Therefore the stronger verified nominal interval is **300 seconds**, rather than the generic library's 600 seconds or a guessed 30 seconds.

The actual device code `065356A000` maps to processor sensor enum 1: the AY1 vtable entry at `0x2bc120 + 0x2e8` resolves to `0x2079a0`, whose comparison at `0x207ef0` matches the constant initialized at `0x20e74c–0x20e770` and returns 1. Constructor transfer through `0x20a914` and `0x22622c` preserves that value. Enum 2 instead matches `065356AA00` and selects the separate 192 × 144 metadata case. Thus the SK02 uses the enum-1 member of the shared mode-1 resource above; the raw-layout F2 selector is a different enum domain. See the actual-device radiometry note for the remaining metadata prerequisites.

After loading the resource, the constructor sends explicit parameter pairs through `IFR_NUC_SetConfig(type=1, size=8)`. Relevant pairs are `(31,1)` at `0x227e74`, `(30,1)` at `0x227fb8`, `(26,1)` at `0x22831c`, and `(27,1)` at `0x228440`. The last three pairs are stored in read-only constants at `0x7aa08`, `0x7a960`, and `0x7aa88`, respectively. These establish host shutter mode 1 and enabled time/temperature triggers at construction.

For TECLESS30, `IFR_NUC_UpdateNucParams` copies mode 1 to both `handle+0xea` and `handle+0xeb` (`0x1eb68`, `0x1ebe0`). The host controller's inline threshold logic (`0x22258–0x222ec`) consequently selects **17 initially**, switching to **25** when the matching gear-ready flag (`+0xf0`, `+0xf1`, or `+0xf2`), captured gear (`+0x610`), and captured type (`+0x611 == 1`) agree. `IFR_NUC_Cali_BCaliSendRawImg` sets these ready flags after background averaging (`0x217a8`, `0x21948`, `0x21968`). This is a state-dependent threshold, not a constant half-degree setting. Subsequent user or SDK configuration can still override the defaults.

The ignored research files `nuc-resource-101c050.bin` and `nuc-resource-101c690.bin` preserve the two extracted resources for local verification. The above facts describe the APK's embedded configuration. They do not prove that every runtime state transition or firmware variant has now been reproduced.

## Remaining validation

The actual factory tables, crop/default gear, first-reference accumulation and full startup correction chain have now been implemented and compared offline against the native library. Radiometry has a separate portable implementation and native comparisons. Remaining work includes:

1. Later A/B/C drift-model transitions, all shutter-controller eligibility/settling states, gear changes and runtime overrides.

2. Long-duration warm-up and dynamic-scene comparisons, including behavior around automatic references.

3. Physical temperature accuracy against controlled reference targets and manufacturer-app outputs.

4. Firmware/model variants and Mac hardware/control validation.

Reading factory tables over USB and performing these arithmetic operations does not intrinsically require an internet connection. That observation does not establish that every manufacturer application feature is offline; only the investigated local calibration path is covered here.

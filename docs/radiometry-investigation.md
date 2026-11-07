# Radiometry investigation

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

This note covers local ARM64 disassembly of the supplied APK's `libMicroTA_Release_v8a.so` and `libMTlib.so`. Addresses identify this APK build only. No vendor binaries or calibration payloads are included in the desktop package, and no guessed detector-count-to-temperature conversion has been enabled.

The [actual SK02 reference investigation](actual-sk02-radiometry-reference.md) now covers this camera's retrieved calibration and online floating-point calculator path. The bundled integer fixture described below remains a separate research reference, not a substitute for the camera's data.

## Pipeline established so far

The application-level MicroTA library wraps three native calculator families: ordinary `MT_*`, online `MT_*_OL`, and integer `MT_*_INT`. `MicroSDK::CalculatorFactroy::create` at MicroTA `0xb4d4c` selects among them using the first field in `TempInitParameters`. Value 3 inspects the calibration block at parameters +`0x18`; value 5 selects the integer implementation directly. The inspection helper at `0xaadd8` calls `MT_CheckCalibParamType_INT`.

The latter function (MTlib `0x8f08`) reads signed32 calibration offset `0x2b10`, multiplies by 30, takes the native signed absolute value, and returns a boolean for `> 10`. The bundled F2 sample has value 1 and selects the integer path through this test. This sample does not establish that every SK02 firmware uses the same calibration type.

The integer measurement chain requires more than corrected pixels:

1. `MT_GetMemSize_INT` / `MT_Create_INT`: allocate and initialize the correct calculator state.
2. `MT_SetConfig_INT` / `MT_SetCalibParam_INT`: install the device's radiometric calibration.
3. Install environmental/model settings, current temperature range, and frame additional-line state.
4. `MT_PreProcess_INT` (`0xfad4`): calculate real responsivity, calculate or set base gray, then configure atmospheric transmission.
5. `MT_Process_INT` (`0x8ae4`): process the point request, including gray-range checks, environment corrections, and `MT_Gray2Temp_INT` (`0x1fc38`).
6. `MT_Gray2Temp_INT`: remove base gray, invert the detector response, convert equivalent blackbody temperature to object temperature, apply the selected additional corrections, and return the native fixed-point result.

The live camera's TECLESS30 nonuniformity correction precedes this radiometry work. The current visual flat field is not the equivalent of that complete correction. See `nuc-investigation.md`.

## Calibration header and size

`MT_SetCalibParam_INT` (`0xe734`) reads two uint32 words from the start of the input: the first is compared with the library's supported version at handle +`0x10`, and the second is passed as the byte count to `memcpy`. A later parser must validate the declared size against the actual input and destination capacity before reproducing this operation; the native function is not a safe standalone file validator.

The ordinary `MT_SetConfig` calibration branch (`0x49a4–0x49c4`) accepts a nonzero buffer length no greater than `0x3800` (14,336 bytes), then delegates to `MT_SetCalibParam`. That function (`0xb270`) inspects offset `0x2b10`: it converts integer calibration to its float working representation when indicated, transforms older versions at or below `0x401`, and otherwise copies the declared structure size. Thus version and numeric representation must both be preserved.

Verified header fields in the two bundled example files:

| Offset | Interpretation established by use | F2 sample | F0 sample |
| --- | --- | --- | --- |
| `0x00` | uint32 version | `0x404` | `0x404` |
| `0x04` | uint32 declared byte size | `0x3800` | `0x3800` |
| `0x08` | Device/model discriminator, meaning not fully mapped | `0x53` | `0x57` |
| `0x10` | NUL-terminated model string; used by `MT_GetDeviceType_INT` (`0xf6b8`) | `P20(IOS)` | `HM-TM30-2RG/DT` |
| `0x2b10` | Signed32 type/metadata scaling coefficient | 1 | 1 |
| `0x2b14` | Signed32 metadata scaling offset | 0 | 0 |

`MT_GetCalibFileVersion` (`0xc5e0`) additionally reads version/build fields around `0x2aa8–0x2ab3` from the installed working calibration and formats a string. Those fields are zero in the two bundled examples. They should not be confused with the structure version at offset zero.

No complete checksum or signature validation for the downloaded file has been established yet. The library exports `MTCALIB_UpdateCRC_EXP` and MD5 helpers; the names alone do not prove that either validates this particular device transfer. Transport integrity and file validity need separate checks.

## Additional-line metadata

`MT_SetAddlParam_INT` (`0xe9e8`) reads a compact additional-line buffer, rearranges fields, invokes `MT_SetADDL1Param_INT` and `MT_SetADDL2Param_INT`, then recalculates responsivity, base gray, and atmospheric transmission. This proves that radiometry is dependent on per-frame state, rather than a single immutable factory lookup table.

For the generic non-`0xb2` branch of `MT_SetADDL1Param_INT` (`0x20884–0x2090c`), each of its first three uint16 inputs is decoded as:

```text
u = word & 0x3fff
signedValue = (word & 0x2000) ? 8192 - u : u
scaledValue = signedValue * calibration.s32[0x2b10]
              + calibration.s32[0x2b14]
```

The first two results are sign-extended from 16 bits before storing. This is not ordinary signed14 two's-complement interpretation. The caller swaps the first two raw additional-line words in this generic path before passing them to this function (`0xea70–0xeacc`). Do not directly assign the callee's field order to the USB transport.

Other callee-relative inputs include word +`0x0a` (masked to 14 bits and checked to be at most 4), words +`0x0c` and +`0x0e` (checked as 0/1 flags), and dimensions at +`0x10` / +`0x12`. Exact semantic names and transport offsets are being traced separately in `frame-metadata-investigation.md`; the compact metadata exported in a JPEG is not automatically the raw camera's extra-row layout.

`MT_SetADDL2Param_INT` (`0x20a3c`) clamps the difference of internal values at handle +`0x10c` and +`0xdc` to calibration bounds at +`0x2bd0` and +`0x2bc0`, storing it at handle +`0x5c`. This is another reason that factory coefficients and live metadata must be applied together.

## Conversion units and arithmetic

The MicroSDK's public integer temperature representation has **13 fractional bits**. `TempMatrix::temp(float&, Coordinate2D const&)` at MicroTA `0xc21fc–0xc220c` multiplies its integer result by float bits `0x39000000`, exactly `1/8192`. `UnitConverter::convertTemperatureUnit` at `0xca068` likewise converts integers using `SCVTF #13` and returns integers using `FCVTZS #13`.

The lower-level **MTlib integer output uses six fractional bits**, not thirteen. MicroTA `0xa7090–0xa70bc` reads the `MT_Process_INT` point result, multiplies by float bits `0x3c800000` (`1/64`), truncates the resulting value to one decimal place, then converts that decimal value into the public Q13 representation. Preserve this boundary: dividing an MTlib result by 8192 would be wrong by a factor of 128. The inverse-response branch subtracts integer 69,926, approximately `273.15 * 256`, before object-temperature processing (`0x1fdd8–0x1fde8`); its temperature is Celsius before any later public unit conversion.

Therefore `temperatureInteger / 8192` produces a value in the API's selected temperature unit. It does **not** imply `rawDetectorWord / 8192` is a temperature, and it does not by itself establish which Celsius/Fahrenheit/Kelvin enum is active. The current app must only label Celsius after its selected conversion path and unit configuration are verified.

The integer radiometry core also uses other scales internally. For example, `MT_Gray2Temp_INT` writes its final result after arithmetic shifting an intermediate by two (`0x1ff4c–0x1ff54`). `MT_ResponseEXPInv_INT` (`0x1f624`) uses integer range reduction and lookup tables with mixed 32/64-bit arithmetic. Replacing these operations with a generic floating-point Planck equation would not reproduce the SDK's rounding, edge cases, or calibration conventions.

The floating path exports `MT_PlanckRadTempCal`, `MT_PlanckRadTemp2Temp`, `MT_ResponseEXPInv`, `MT_ResponsePWPInv`, and `MT_BBtemp2Objtemp`, among others. `MT_GetGray2TempTable` (`0x1504c`) constructs a lookup through the configured conversion pipeline, starting with the 14-bit upper gray bound `0x3fff`; `MT_SubFunction` calls it at `0x5ff0`. Table-generation behavior, interpolation, invalid entries, and regeneration conditions remain to be reproduced. A valid temperature table is a derived artifact of calibration and current settings, not a palette.

## Useful bundled fixture

The APK includes these JPEG files under `assets/SRTestImage`:

- `F2v2I_20260113163505725_E_O_$20260113163505725.jpg`, 238,991 bytes, SHA-256 `cf7b60b98f943e1034b063543741762984c9d344e25f983b780db7067de9c693`.
- `F0I_20260113163439299_E_O_$20260113163439299.jpg`, 126,218 bytes, SHA-256 `54c734456389314888ad2b4ce635cc098dba454a949218be7775a8a62a22a1fb`.

They contain SDMP application segments in addition to a visible JPEG. The observed segment layout has a 16-byte `SDMP` header, followed by a little-endian uint16 entry count and 12-byte entries: uint16 tag, uint16 type, uint32 count, and uint32 inline value or offset. Offsets for external values are relative to the entry-count position. This description is verified for these examples and is not yet a general parser specification.

For the F2 example, APP2 at file offset `0x79f` contains tag `0x0207`, type 7, count 14,336, offset 161. Its calibration data starts at absolute file byte 2,132. Tag `0x0200` is 3, consistent with MicroTA's automatic calculator selection.

APP3 block index 5 is split across segments at `0x51c0` and `0x151c0`; the second header declares continuation offset 65,516. Concatenating their payloads produces 99,146 bytes. Within the reconstructed block:

| Tag | Type / count | Value |
| --- | --- | --- |
| 0 | uint16 / 49,152 | Image plane at payload offset 74 |
| 1 | uint16 / 384 | Additional-line metadata at offset 98,378 |
| 2 | uint32 / 1 | 192 |
| 3 | uint32 / 1 | 256 |
| 4 | uint8 / 1 | 14 |

The metadata begins `[2101, 1385, 0, 38, 7, 1, 0, 0, 192, 256, 69, ...]`. Ignored local research extracts are `f2-jpeg-calibration.bin`, `f2-jpeg-image.bin`, and `f2-jpeg-addlines.bin`. They are useful for parser and algorithm investigation; they must not become replacement calibration for the user's attached camera. The sample model string differs from the attached SK02 identity. No proprietary data is committed as a fixture.

## Practical next steps and platform boundary

First establish a bounds-checked calibration and compact-metadata parser using the bundled sample, then trace its selected integer path and compare it with the original native implementation offline. Port responsivity, base-gray, environmental correction, inverse response, and output validity as separate tested steps. Once USB extraction succeeds, repeat against the attached camera's own data and known reference targets before exposing center/high/low Celsius measurements.

At this checkpoint, Windows raw capture and manual internal shutter reference work through the standard driver. Factory-table transfer is still being validated: protocol research found the missing SDK503 chunk envelope, so the earlier failed dynamic-length attempts do not establish a Windows driver limitation. macOS raw capture and packaging still require a Mac hardware test, and its vendor-control transport is not implemented. The Android ARM libraries cannot simply be loaded into an ordinary Windows/macOS Electron process. A portable implementation or an appropriate desktop SDK is still required.

## Offline ARM64 reference oracle

`scripts/research/mtlib-oracle.py` runs the supplied `libMTlib.so` in Unicorn with ELF relocations and small libc/math import stubs. It contains no vendor data. The research-only packages are Unicorn **2.1.4** and pyelftools **0.33**, downloaded from PyPI into ignored `research/python-deps`. No emulator, Android binary, or vendor fixture is a shipped application dependency. Python host `exp`, `log`, `sqrt`, `pow`, and `ldexp` substitute for Android libm; last-bit math differences remain possible. This is a useful reference for a future portable implementation, not a proven bit-identical Android runtime.

The successful initialization sequence is:

1. `MT_GetMemSize_INT(ability, memTab)` with two uint32 ability dimensions. For the portrait-oriented JPEG these are 192 and 256. The 48-byte memory table contains two 24-byte entries, with pointer at +0, size at +8, alignment at +12. It requests 14,976 persistent bytes and 128 scratch bytes, both aligned to 128 bytes.
2. Allocate the buffers and call `MT_Create_INT(ability, memTab, handleOut)`.
3. Install the fixture with `MT_SetCalibParam_INT(handle, calibration)`.
4. Configure environment using `MT_SetConfig_INT(handle, 1, pair, 8)` where each pair is two signed32 words. Verified setters include key5 ambient temperature Q13, key6 relative humidity percentage Q13, key7 distance in meters Q13, key13 spectral/lens index, key15 device discriminator, key35 debug verbosity. The first three setters convert into internal scales, so writing their raw handle fields directly is not equivalent.
5. Feed the 768-byte compact fixture metadata into `MT_SetAddlParam_INT(handle, metadata)`.
6. Call `MT_Process_INT(handle, 0, points, count)` and check both its return and each point's status. This full call prepares object-temperature correction and gray limits. Calling `MT_Gray2Temp_INT` directly after metadata installation is insufficient and returned -19 in the initial experiment.

The observed 32-byte point structure is:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | int32 | Per-point return status, written by the library |
| 4 | uint32 | Input corrected gray value |
| 8, 12 | uint32 | Zero in the tested point call |
| 16 | int32 | Output temperature Q6 |
| 20 | uint16 | Input emissivity Q13 |
| 22 | uint16 | Padding |
| 24 | int32 | Input reflected temperature Q13 |
| 28 | int32 | Input distance in meters Q13 |

`MT_Process_INT` rewrites some input environmental fields to internal scales. Rebuild each point structure before reusing it. The call can return zero while an individual point has an error; checking only the overall return is insufficient.

With the bundled F2 fixture and explicitly chosen exploratory settings of ambient/reflected 20°C, humidity60%, distance1m and emissivity0.97, initialization, metadata, overall process status, and each point status all returned zero:

| Corrected gray | Native Q6 result | Celsius |
| --- | --- | --- |
| 5,218 (fixture minimum) | 1,510 | 23.59375 |
| 5,500 | 2,081 | 32.515625 |
| 5,555 (selected central fixture pixel) | 2,189 | 34.203125 |
| 5,754 (fixture maximum) | 2,556 | 39.9375 |

These are native-library reference outputs under stated settings, not an accuracy claim, not the fixture's verified recorded environment, and not temperatures from the user's SK02. Initially relying on native defaults produced -305 from atmospheric-transmission validation; explicit environment configuration resolved it without bypassing validation.

The committed research runner requires every environmental value explicitly, rejects incomplete calibration/metadata, preserves per-point failures as null temperatures, and emits input, runner, and result SHA-256 hashes in its JSON report. It records Python/package versions, actual encoded Q13 settings, and key/value configuration calls. Input encoding uses Python's nearest-integer, ties-to-even rounding; this is explicit and not claimed identical to every MicroTA caller's conversion. It currently chooses spectral index0 and parameter29=0, matching this bounded experiment; these choices still need reconciliation with each actual device's configuration. The initial exploratory script also remains in ignored `research/` for provenance.

Reproduction after local APK extraction (use an installed Python executable; no system-wide package installation is required):

```powershell
python -m pip install --target research/python-deps unicorn==2.1.4 pyelftools==0.33
python scripts/research/extract-sdmp-fixture.py 'research/decompiled/resources/assets/SRTestImage/F2v2I_20260113163505725_E_O_$20260113163505725.jpg' --out-dir research/f2-fixture
python scripts/research/mtlib-oracle.py --library research/decompiled/resources/lib/arm64-v8a/libMTlib.so --calibration research/f2-fixture/calibration.bin --metadata research/f2-fixture/metadata.bin --width 192 --height 256 --ambient 20 --reflected 20 --humidity 60 --distance 1 --emissivity .97 --gray 5218 5500 5555 5754 --benchmark 1000
python scripts/research/test_sdmp_fixture.py
```

`extract-sdmp-fixture.py` separates APP2 and APP3 block namespaces, validates continuation offsets and IFD bounds, and emits a provenance manifest. It was run against both bundled F2 and F0 JPEGs; the F2 output hashes matched the independently extracted research files. This does not constitute validation against arbitrary SDMP versions.

The emulator caps each native call at one billion emulated instructions and restricts its mapped memory, allocation sizes, and imported string/memory operations. The instruction cap is not a wall-clock timeout. `scripts/research/test_sdmp_fixture.py` exercises the extractor with synthetic data and does not require the APK or vendor files.

On this Windows computer, four separate point queries took **4.87ms** in total. A single native call with **49,152 repeated sample points took27.46s**, with overall status0 and no failed point statuses; a1,000-point batch took0.566s. This measures emulator execution with the current Python instruction hook, not a native desktop implementation or a live frame pipeline. It is practical as an offline algorithm oracle and unsuitable for rendering a full temperature matrix at camera frame rate in this form. All benchmark outputs remain in ignored `research/`.

The thermometry download is separate from pixel KMatrix files. Protocol investigation traces SDK command2054 to selector3/subcommand14, a five-byte size reply, then SDK503 chunk reads. After stripping transport chunk headers, its body contains a 64-byte name/header, uint32 length at64, and calibration bytes at68. See `protocol-investigation.md` for the transfer evidence and current validation status.

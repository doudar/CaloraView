# Actual SK02 native radiometry preflight

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

This is the historical native initialization/preflight experiment. The later portable live implementation and comparisons are documented in [portable radiometry](portable-radiometry.md), [factory pipeline](factory-startup-pipeline.md), and [status](STATUS.md).

This experiment uses the exported calibration from serial `A43EB0_EXAMPLE`

and metadata from its saved Windows raw capture. No bundled JPEG calibration

or metadata is substituted. It establishes native library loading and API

behavior, not accurate scene temperatures or a complete live pipeline.

## Device data

The strict export validator accepted `research/sk02-device-export-20261107/files`.

Thermometry calibration SHA-256 is

`e256ba8addb9f0f914b58123f2cccb7f5a5fc7570884806eefd66ee21144f462`.

It contains 14,336 bytes, version `0x404`, matching declared size `0x3800`,

device discriminator `0x53`, and model `HM-TJ12-3AAY1F`. K/K2 each contain

49,152 uint16 words; their observed ranges are 30,275–37,077 and 30,244–45,000.

The eight-byte BPM is retained for separate format interpretation.

The integer-type discriminator at calibration `0x2b10` is **zero**, unlike the

bundled integer fixture. The float metadata scale at `0x27ec` is approximately

0.02, with zero offset at `0x27f0`. Do not apply the fixture's Q6 integer

calculator merely because its resolution or calibration length is similar.

For MicroTA's automatic calculator mode 3, `CalculatorFactroy::create`

`0xb4dd0` calls the type check at `0xaadd8`. A false result selects constructor

`0x9b9a0` at `0xb4e54`; its helper `0xadfe0` calls `MT_GetMemSize_OL` at

`0xae058`, and `MT_Create_OL` at `0xae7e0`. This is the **float online** family.

The library's actual `MT_CheckCalibParamType_INT` returns zero for this file.

Other explicit calculator modes can override the automatic choice; this

experiment reproduces that automatic branch, not every application setting.

## Verified initialization and API differences

`MT_GetMemSize_OL`, `MT_Create_OL`, and the shared `MT_SetCalibParam` all return

zero with this camera's calibration and ability `[256,192,0,0]`. The native

memory table requests 15,616 persistent bytes and 1,433,728 scratch bytes.

Explicit exploratory settings also return zero through `MT_SetConfig_OL`:

| Key | Encoded value | Experiment meaning |

| --- | --- | --- |

| 5 | 20,000 | Ambient 20 °C |

| 6 | 60,000 | Relative humidity 60% |

| 7 | 1,000,000 | Distance 1 m |

| 13 | 0 | Assumed spectral/lens index |

| 15 | 83 | Actual calibration device discriminator |

| 29 | 0 | Explicit exploratory mode choice |

| 35 | 6 | Quiet debug level |

These configuration inputs differ from `MT_*_INT`: the float setter uses

the float32 0.001 constant at `0x22fd0`; distance applies it twice

(`MT_SetParam` `0xac0c`–`0xac24`). Float point requests use 36-byte records:

int32 status at 0, uint32 corrected gray at 4, coordinates at 8/12,

float32 temperature at 16, emissivity at 20, reflected Celsius at 24,

and distance in millimeters at 28. The native process converts the point

distance by 0.001 before atmospheric calculations. The final word is retained

as native output. Float temperatures are neither Q6 nor Q13 integers.

## Own-capture metadata and remaining gap

The source is frame 0 of `research/shutter-JEHPUQ/sensor.raw`, SHA-256

`c5b3fa9997b94274dd3795cc85a726269d50c3e1cee0228f74a3ef0eaa0e8216`.

The first two additional rows are copied from row 216, taking 512 bytes from

each 528-byte USB row. The resulting 1,024-byte compact buffer has SHA-256

`ff4f85f814bdfffd125f1e90269cb1cc4de22614d380365d73945d533a38e60a`.

This raw extraction returns **-19** from `MT_SetAddlParam`.

The raw buffer starts `[0,1526,1526,34,5,3907,0,0,216,264,...]`. Native

`MT_SetADDL1Param` rejects gear greater than 4 (`0x14e30`–`0x14e3c`), while

the unprocessed USB word 5 is 3,907. This is concrete evidence that copying

raw extra rows is insufficient; MicroDM rewrites host metadata before

radiometry. Its synthesized FPA word 0 and NUC state also matter.

For a clearly bounded experiment, a copy of this same metadata changes only

word 5 to assumed gear 1, word 8 to cropped height 192 and word 9 to cropped

width 256. Word 0 remains its raw zero. With those **unverified host-state

assumptions**, `MT_SetAddlParam` returns zero and `MT_Process_OL` executes.

An arbitrary count 5,000 returns overall status zero but per-point -19 and a

null temperature. Other uncorrected raw counts yield numeric outputs, which

are deliberately not accepted as scene measurements. Successful status does

not repair missing NUC, prove gear selection, or establish the FPA value.

Subsequent static tracing verifies word5 constant1 and this sensor's 256 × 192

header dimensions; see [the host metadata trace](host-metadata-normalization.md).

It also identifies further host-state writes and image-dependent

`MT_SetConfig_OL` command7 preparation. The earlier exploratory report remains

unchanged as provenance and is not upgraded to valid radiometry.

Local evidence and exploratory runner are in `research/sk02-native-reference/`.

`float-online-oracle.json` records the actual file hashes, settings, statuses,

dependency versions and output digest. Its point-results digest is

`2f30a0d22ae8b7b7a84b7a45c672339244c00a950fc32441567651037da79065`.

No output from this experiment is connected to the desktop display or CSV.

## Reproduction and next prerequisites

The reusable research runner now supports `--calculator float-online` and

rejects a calculator family inconsistent with the calibration discriminator.

Its default remains `int` for the separate bundled-fixture regression. The

integer fixture's point-results digest remains unchanged:

`448332df991af70fda23cd864b745319db35d920483a187e89ba72c2d5545c29`.

```powershell

python scripts/research/mtlib-oracle.py --calculator float-online --library research/decompiled/resources/lib/arm64-v8a/libMTlib.so --calibration research/sk02-device-export-20261107/files/thermometry-calibration.bin --metadata research/sk02-native-reference/exploratory-metadata.bin --width 256 --height 192 --ambient 20 --reflected 20 --humidity 60 --distance 1 --emissivity .97 --gray 5000 7265 9447 16069

```

The host math stubs include float32 `sqrtf` and ties-away-from-zero `lround`;

host libm may still differ from Android in its last bits. A successful oracle

run remains a reference experiment, not a native desktop performance claim.

Before live temperature integration, reproduce the verified F2 host metadata

rewrites, gear selection and synthesized FPA field; run complete factory NUC

with the camera's own K/K2/BPM and shutter state; feed the corrected values and

matching metadata into the selected native reference path; then compare the

portable implementation and known physical reference targets. Keep scene

temperature fields unavailable until those prerequisites are established.

# F2 frame metadata and sensor drift input

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

Evidence below is from the supplied APK's ARM64 `libMicroDM_Release_v8a.so` and `libifrnuc.so`, plus locally recorded SK02 frames. Addresses refer to those exact binaries. This identifies a sensor signal used by the APK's shutter controller. It does **not** establish radiometric scene temperature or complete APK calibration equivalence.

## Verified active input

For the F2 layout, the input used by the default host NUC controller is little-endian word **1 of row 216** in a 264 × 222 frame: absolute byte offset **114050 (`0x1bd82`)**. The native log names this value **CAV**. This conclusion comes from tracing the data path, rather than selecting the field whose observed values look like temperature.

| Step | Native evidence |

| --- | --- |

| F2 additional data starts at row 216, column 0 | MicroDM `0x25f6b0` returns frame + `0x1bd80`; getters report 6 rows, 264 words/row, 3168 bytes. |

| Copy preserves the start of each additional row | `0x25f6d8` copies 512 bytes per row from that origin, using the 528-byte source stride. No horizontal crop is applied to additional data. |

| Raw frame enters the additional-data buffer | `0x274b34` receives the additional destination as argument 3; the F2 adapter vtable at `0x2bcac8` is installed at `0x2756c0`. Virtual slot `+0x88`, called at `0x2757e8`, resolves through relocation `0x2bcb50` to `0x25f6d8`. |

| Additional buffer reaches NUC processing | `0x270aa8` passes processor storage `+0x68` as the additional destination; `0x271fd8` passes the same storage to `0x237980`, which passes it to `0x23ca40` at `0x238950`. |

| Word 1 is extracted as CAV | `0x24ba78` loads additional-buffer `+2`, stores to output argument 2 at `0x24ba80`. Caller `0x23d004` points that argument to stack `+0xb8`. String `0x778da` labels its logged value `CAV=`. |

| Missing values retain the previous nonzero value | `0x23d3bc–0x23d3d4` updates processor `+0x554` only for nonzero CAV; `0x23d558` uses that saved value when required. |

| Value enters the NUC realtime structure | `0x23ef74` loads stack `+0xb8`; `0x23ef88` writes stack `+0x1e4`, which is realtime `+0xa4` because the realtime argument begins at stack `+0x140` (`0x2406b4`). |

| Default selects that input | `IFR_NUC_InitSpec` `0x1a2cc` sets handle `+0xfa` to 1. MicroDM constructor also sends parameter `(532,1)` from constant `0x7aaa8` at `0x228200`; parameter handler `0x1bcf8–0x1bd00` writes the same flag. |

| Decode and use | `IFR_NUC_Process` `0x1d614–0x1d62c` reads realtime `+0xa4`, converts the encoded sign, and writes handle `+0x1e` and `+0x20`. `NUC_ShutterCtrl` uses `+0x1e` for its drift comparison. |

For supported 14-bit words, the native conversion is:

```text

sensorCounts = raw < 8192 ? raw : 8192 - raw

sensorUnits  = sensorCounts / 50

```

The sign is **not** ordinary int16 two's complement. The scale of 50 is directly observed in `ASIC_ShutterCtrl` at `0x7e5c`; the host controller compares integer counts without division. Initial threshold 17 and reference-ready threshold 25 consequently correspond to 0.34 and 0.5 internal units. The host comparison is inclusive (`>=`). See `nuc-investigation.md` for gear/state qualifications and the 300-second embedded interval.

`src/core/frame-metadata.cjs` implements this field extraction without device I/O. It returns raw and signed counts, an explicitly named internal-unit value, and validity. Zero is reported missing rather than carrying a previous frame's signal implicitly. Values with the upper two bits set are rejected conservatively: the NUC code itself does not mask them, and their meaning is not established. The parser never calculates scene Celsius. Three synthetic tests cover exact position, sign boundaries, missing values, size/type validation, and input preservation.

## Why the FPA formula is a different input

The SDK also calculates a value named FPA temperature in `FpaTempCalculator::calculateFpaTemp`, MicroDM `0x285aa8`. Its argument contains data pointer, width, height, byte stride, and sensor enum. The call passes the cropped256 × 192 detector image, so it averages column255 at rows0,10,...190 (raw column259, rows2,12,...192). The resolution loads at `0x1fac8c–0x1faca0` and call setup `0x23d6d4–0x23d700` establish this geometry. It is not established that this column is optically masked. With mean `v`, the enum 1/2 formula uses float32 constants:

```text

t = ((v * 0.1459999978542328 + 800) - 2000) / 10 + 25

```

Enum 0 uses `0.26899999380111694` and subtracts 1900 instead of 2000. Arithmetic includes a fused multiply-add, so this algebraic expression alone is not a bit-exact port. Unknown enums log use of the default formula. Call site `0x23d700` invokes it; `0x23dc00–0x23dc0c` truncates the result to an integer **before** multiplying by 50, then `0x23dd54` overwrites additional word 0 and `0x23ef84` supplies it as realtime `+0xa2`.

That synthesized FPA input is overridden by CAV when `handle+0xfa` is 1, as it is in the constructor defaults traced above. Consequently, sampling image-border words or using the FPA formula is unnecessary for the established CAV drift path. The production float32 port matches 118 native cases including 112 own recorded frames. Additional word 0 in an exported SDK JPEG can differ from word 0 in an untouched USB frame because the SDK mutates it. Exported metadata must not be treated as an unmodified raw-frame fixture.

## Recorded-frame checks

The ignored local `research/sample.yuyv` contains 10 complete frames. CAV is 1516 in every frame, corresponding to 30.32 internal units. The ignored `research/shutter-JEHPUQ/sensor.raw` contains 112 complete frames around the verified shutter cycle; CAV ranges from 1525 to 1527, with 1526 in the first and last frames. The source raw buffers are retained; no private imagery is copied into test fixtures.

These checks establish that the selected field exists and behaves plausibly in actual SK02 captures. They are not a temperature accuracy test. Factory radiometry, runtime overrides, field behavior across disconnect/restart, and comparison with manufacturer output remain separate validation work. The parser alone does not implement native shutter eligibility, background averaging, or calibration state transitions.

## Offline trigger-policy helper

`src/core/shutter-schedule.cjs` is a pure, **not wired to device controls** comparison helper. It returns `sensor-drift`, `interval`, or null using explicit monotonic timestamps and validated signed CAV counts. Its comparison follows the recovered host branch: inclusive drift threshold 17 initially or 25 with matching reference readiness, and inclusive 300-second elapsed interval. Drift takes priority when both are due. Missing metadata disables drift; time can still be due with a valid time baseline. Missing baseline or a backwards clock yields no trigger. Busy and recording suppress all reasons as application safeguards, not claimed manufacturer behavior.

The helper does not choose a startup action, mutate baselines, retry a failed cycle, or impose an invented cooldown. Repeated calls remain due until the caller records a successful reference and updates the baseline. The native `referenceReady` condition includes matching gear, captured gear, and captured correction type; a generic successful visual flat field is not proof of that native state. Other native mode/eligibility flags, background preparation, shutter phases, and completion/baseline timing remain outside this comparison helper. Any live controller must explicitly establish those conditions, serialize commands, preserve reopen/release recovery, reset state across reconnects or clock origins, and choose a documented failure/retry policy before claiming native equivalence.

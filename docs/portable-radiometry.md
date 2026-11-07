# Portable SK02 radiometry

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

`src/core/radiometry.cjs` is a portable JavaScript implementation of the inspected
SK02 float-online calculation. It loads the connected camera's validated
thermometry calibration, not an APK library. No vendor binaries, emulator or
example-image calibration is required by the application.

The supported calibration is version `0x404`, device discriminator `83`, model
`HM-TJ12-3AAY1F`, float calculator, lens zero, gear one, ranges zero through two.
The verified default camera selector three becomes metadata range two. Unsupported
external-optics, spectral and distance-polynomial branches fail closed.

## Interface and validity

`createRadiometry(calibrationBuffer, {serial, environment, generatedReference})` returns an object with
`evaluate(correctedUint16Plane, normalizedMetadata)`. The caller must first validate
the calibration export against the current camera identity and finish detector
NUC, fixed-pattern, bad-pixel and applicable vignetting processing. The corrected
plane is 256 by 192 in detector orientation; metadata contains at least two compact
512-byte rows. A preview flat field is not a substitute for this processing.

The result has `temperatures: {center, high, low, highX, highY, lowX, lowY}` and
calibration provenance. Every detector pixel is considered; extrema are determined
from converted temperatures, without assuming the curve is globally monotonic.
Any unsupported metadata, nonzero host/shutter validity flag, missing live CAV,
invalid detector count or failed/out-of-range conversion suppresses the whole
temperature summary. This prevents partial extrema from concealing invalid pixels.
Native clamp values are never presented as successful measurements.

The application starts with emissivity 0.91, distance 3 ft (0.9144 m), ambient
and reflected temperature 20 C, and relative humidity 60%. The Parameters dialog
edits and persists these configured inputs; they are not room-sensor measurements.
Earlier native comparisons using emissivity 0.97 and distance 1 m are explicit
reference vectors, not the current application defaults. The low-level helper's
omitted-argument defaults are separate from the app's persisted settings.

Ambient/humidity inputs follow the native setter encoding. Distance follows the
traced SDK meter/Q13 boundary; see [environment-stage evidence](radiometry-environment.md)
for the corrected conversion and historical low-level probe distinction. Original
requested settings are retained in provenance. Physical accuracy remains unverified.
The earlier approximately 4 C-low comparison predates the generated-reference fix.

## Arithmetic and evidence

The calibration-specific response preparation follows `MT_CalcRealRespnsCoeff_OL`
at `0x1d6a8`: CAV-dependent linear/quadratic responsivity, reference blackbody gray,
and adjusted Planck coefficients. `MT_CalcBaseGray_OL` at `0x1cd70` supplies the
piecewise ambient-drift base correction. `MT_Gray2Temp` at `0x135b8` inverts this
response, preserves integer truncations, and reports native out-of-range statuses.
The environmental implementation documents its atmosphere and object-temperature
equations in `docs/radiometry-environment.md`.

For this calibration and normal reference mode, live additional-row word one is
the CAV used by response compensation. Word zero is decoded FPA, but is not a
substitute for CAV. Word twenty is cached CAV; it does not replace word one in this
branch. Word twenty-seven is used by newer-than-0x404 base-gray branches, which are
not supported here. Native reference mode is handle offset `0x124`, parameter 22,
default zero. Parameter 29 is a separate field at `0x1c`.

`scripts/research/compare-radiometry-state.py` performs local differential checks
using the bounded native oracle. It checks 288 combinations per range: six CAV
values, three ambient temperatures, eight detector counts, and both metadata-only
and command-seven image-plus-metadata preparation. All 864 cases matched exactly
for response coefficients, base/reference gray, blackbody temperature, final
object Celsius and native failure status. This includes invalid and clamped
inputs; it is arithmetic equivalence, not proof of scene accuracy.

Example local command (native inputs remain outside the published application):

```powershell
python scripts/research/compare-radiometry-state.py --calibration research/sk02-device-export-20261107/files/thermometry-calibration.bin --metadata research/sk02-native-reference/exploratory-metadata.bin --range 2
```

The tested camera calibration SHA-256 is
`e256ba8addb9f0f914b58123f2cccb7f5a5fc7570884806eefd66ee21144f462`.
Unit tests use invented calibration coefficients, never copied vendor media.

## Actual recorded-frame integration check

The validated eight-file export for serial `A43EB0_EXAMPLE`, including its actual
VC table, was applied to the 20-frame closed-shutter recording with SHA-256
`7c6ddb5dcf29660ce76549108a0be53f9a93d0235045a8dbac42cf8b6614b254`
and the following 45-frame scene recording with SHA-256
`b2455c387e7ee196530f7e51968186991be461f27506dce4002c3eb3251c8c85`.
All 45 frames yielded valid summaries. On this Windows computer the complete
portable processing took a mean 1.80 ms/frame, 95th percentile 4.37 ms, including
the initial computation (the 25 fps frame budget is 40 ms).

The first frame's corrected center/high/low counts were 7333/7918/7225. Its real
normalized metadata and the same device calibration were passed separately to
the native float-online oracle. Both implementations returned exactly
15.119781494140625 / 33.10345458984375 / 11.42987060546875 C, with all native
statuses zero. The metadata SHA-256 was
`56f1b4a2fc0adc2e27f262462f0567472ef18c7fe914f08de9943b5ceb957d31`.
This checks the real metadata-to-temperature connection; it does not establish
the physical temperatures of the recorded objects.

`scripts/research/check-temperature-pipeline.cjs` reruns the complete portable
integration with explicit export, serial, closed-reference and scene paths. It
records input hashes, requested environmental settings, acquisition diagnostics,
per-frame failure reasons, numerical outputs and timings. It never opens hardware.

## Generated-reference pipeline

The application explicitly enables `generatedReference:true` on connection and
parameter changes. `radiometry-inter.cjs` reproduces the generic native producer's
CAV-dependent reference, then applies the float-online consumer's ambient-drift
correction once. The algorithm identifier is
`sk02-float-online-port-v3-generated-reference`. The core default remains false
for historical v2 comparisons; the application uses v3. No measured-temperature
offset or replacement factory coefficient was fitted to the phone or thermometer.

The producer and consumer matched 1,476 native differential cases. On the actual
DDAC diagnostic capture, the complete native correction replay matched 1,228,800
pixels, and a separate 25-frame generated-reference/temperature replay matched
all 75 center/high/low values exactly. The controller-selected and separately
saved eight-frame references are distinct nearby windows; their first center
results differ by about 0.03 C. Neither comparison establishes absolute accuracy.

The app retains manual air, reflected-temperature and humidity inputs. In the
inspected native online calculator, configured ambient is shared by the base-gray
drift and atmospheric stages. The Android host can instead populate that setting
from its internal self-heating estimate, and may initialize an unset reflection
from that estimate. This host behavior is separate from a measured room sensor.
Experimental provenance and `absoluteAccuracyValidated:false` remain recorded
until independent physical validation.

# Portable environmental correction

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

## Automatic reflected temperature (2026-11-07)

The desktop now defaults `reflectedManualOverride` to false. It initializes
reflection from the first valid CAV word received after loading this camera's
calibration on connection, applies calibration floats at 0x27ec/0x27f0, then
reproduces the MicroRVP milli-Celsius and Q13 boundary. This implements the
inspected **fresh producer, rise=0** initialization of an unset reflection.
It is an internal-camera-based estimate, not a measured reflected background.
It does not establish the phone's actual process history or iOS implementation.

The estimate is retained across shutter cycles, measurement-setting changes,
and manual/automatic toggles. Reconnect starts a new estimate. This intentionally
does not continuously follow sensor heating. Air temperature and humidity retain
their configured values; this change implements only automatic reflection.

The Parameters dialog shows the estimate read-only until **Manual override** is
checked. Old preferences adopt automatic mode but retain their manual value.
Changing the mode invalidates held measurements through the existing settings
path. Snapshot/session metadata separate effective `environment` from
`configuredEnvironment`; CSV appends reflected Celsius, Fahrenheit and source.
Pending automatic estimates are null/blank, never the dormant manual value.

Regression checks cover the native bridge vectors, first-reading retention,
reconnect reset, manual equivalence, preference migration, C/F dialog behavior,
and export provenance. Numerical and UI validation does not establish that the
reported 78.3 F versus 73.6 F discrepancy is resolved; a fresh comparison remains
necessary. Earlier manual-only descriptions below document the prior state.

### Calibration-cycle follow-up

The user requested matching the APK's refresh timing. The observed live-decoder
branch at MicroRVP 0x1722e8 compares rule reflection against 0xffdddb34 and jumps
past the update when it already has a value (0x1722f0 -> 0x17230c). Only the unset
branch stores the parsed predicted ambient in Q13 and calls the rule update at
0x172308. Changing ambient in later frames therefore does not itself refresh
reflection. The saved native oracle covers unset and already-set rules.

The Java UvcAdapter manual-calibration method forwards directly to
triggerManualCalibration (or the separate old-stream command), without rebuilding
measurement rules. Native MicroSensorDCBase::triggerManualCalibration at
0x118fe8 sends ConfigCommand 10. The UVC implementation vtable slot +0xa8 resolves
to 0x1a2718 (vtable address point 0x2bb260); its command-10 branch at 0x1a2a1c
calls the device's virtual +0x188. For the inspected AY1 vtable 0x2bc120, that slot
resolves to 0x20ce78. Its host correction request calls 0x23604c, whose successful
request sets the processing-state byte +0x370 at 0x236674. No reflection-sentinel
reset or rule replacement was found in this inspected request path.

This supports retaining the current reflected estimate during ordinary shutter
calibration. It is a bounded static trace, not proof of every asynchronous callback,
alternate device path, or iOS implementation. Do not describe it as proof that
reflection can only ever change at application startup. Recreating a rule with an
unset reflection can initialize it again. No periodic refresh was added.

`src/core/radiometry-environment.cjs` implements the inspected device83 FLOAT ONLINE environment branch independently in JavaScript. It loads no vendor binary. This verifies arithmetic, not scene accuracy: the full live pipeline must still supply the correct factory tables, NUC output and rewritten metadata.

`prepareEnvironment(calibration, options)` accepts the exact 14336-byte calibration and explicit ambient/reflected Celsius, humidity percent, low-level MTlib distance, emissivity fraction, range0–2 and lens0. Application inputs in metres must first pass through `normalizeSdkEnvironment`; this boundary is essential. It returns float32 environmental values, `status` and `tau`. `blackbodyToObject(bbC, environment)` returns `{status, celsius}`. Invalid configuration throws; native atmospheric failure is -305, invalid object-temperature energy is -19, and invalid results are null. Alternate spectral and custom polynomial branches are rejected. No other camera's coefficients are substituted.

Evidence in the locally extracted ARM64 `libMTlib.so`:

- `MT_SetAtmTrsmit` 0xa324 uses handle+1 (lens) and handle+0xf9 (range). Atmosphere coefficients start at calibration+0x21ac+160*lens+32*range; custom polynomial fields are +0x3680+16*range. The default optional correction reads +0x3758+48*lens+16*range.
- `MT_CalcAtmTrsmit` 0xfd48 evaluates the ambient water-vapour polynomial, humidity attenuation, piecewise gas attenuation and visibility attenuation. The implementation preserves individual ARM single-precision operations and double-precision exp/pow calls. Fixed native particle and visibility defaults are .03 and 10000.
- `MT_BBtemp2Objtemp` 0x13100 selects the spectral branch only when both calibration floats+0x3784/+0x3788 are nonzero. They are zero for the actual export. The selected fallback begins at 0x1337c. It computes fourth powers in Kelvin, includes the fixed .97 reference emissivity and complementary ambient contribution, removes reflected and atmospheric contributions, divides by emissivity times transmission, and takes two float32 square roots. The .97 reference factor must not be omitted.
- Historical low-level probes obtained transmission .4058983027935028 with direct MTlib distance1. That was incorrectly labeled as the SDK1m path. The traced SDK boundary supplies native point1, then MTlib scales it to approximately.001 before this function; the live range2 transmission is .9717546105384827 at configured20°C/60%RH/1m. See the correction below.

The direct native differential probe matched **2,916/2,916 cases exactly** for actual calibration, and another **2,916/2,916** using explicitly synthetic atmosphere fields: three ranges, three ambient temperatures, three humidity levels, three distances, three emissivities, three reflected temperatures and four blackbody temperatures. Both statuses and float32 outputs were compared. Synthetic underflow includes native -305; low-energy combinations include -19. Twelve synthetic vectors are committed as unit tests; no factory table is embedded in them.

Reproduce using the documented local Python environment with Unicorn2.1.4 and pyelftools0.33, and locally extracted/provided inputs:

```powershell
python scripts/research/radiometry-environment-probe.py --library research/decompiled/resources/lib/arm64-v8a/libMTlib.so --calibration research/sk02-device-export-20261107/files/thermometry-calibration.bin --metadata research/sk02-native-reference/exploratory-metadata.bin --out research/environment-reference.json
node scripts/research/check-environment-reference.cjs research/sk02-device-export-20261107/files/thermometry-calibration.bin research/environment-reference.json
# Add --synthetic and use a separate output path to verify synthetic coefficients.
node --test test/radiometry-environment.test.cjs
```

The probe runs only selected native environment functions with explicit state, through the existing research-only emulator. Its library/calibration hashes are included in the report. It inherits the per-call instruction ceiling from the oracle; that ceiling is not a wall-clock timeout. It performs no USB calls. See [actual radiometry reference](actual-sk02-radiometry-reference.md) for pipeline limits.

## SDK input normalization

`normalizeSdkEnvironment(options)` rounds ambient and humidity to native milli-units and float32 setter scaling. Distance uses a separately verified Java/SDK boundary: UI metres are truncated to float32 Q13, decoded by MicroTA, and passed directly as the native point distance. MTlib then multiplies by.001. The former app boundary inserted an extra factor1000 and over-attenuated the scene. `encodeSdkDistance` preserves the Q13 truncation and native float32 operations; the unnormalized configured distance remains in measurement provenance.

Evidence for the correction:

- Java `SensorPreviewFragment.z6` converts displayed feet to metres using×0.3048 before storing `emissionDistance`; `p294y5/a.java` writes that value through `FloatConverter.floatToUIntd3` (float×8192, truncated).
- MicroTA point path `0x9c60c–0x9c628` decodes Q13, multiplies/divides by10, and writes native point+28. The whole-region path `0x9e3b4–0x9e3c8` performs the same operations. Neither multiplies by1000.
- MicroTA global setter `0xa3674–0xa36c4` decodes Q13 and multiplies by1000 for parameter7. MTlib setter applies.001 twice, whereas point processing `0x70ac–0x70d8` applies it once. These are distinct interfaces, not physical-unit guesses.
- MTlib parameters55/66/68 write flags+0x1a3/+0x441/+0x498. Defaults are0/1/1. Optional gas-scale override conditions at `0xa3b8–0xa450` do not apply here because this unit's +0x21c4 and+0x3758 coefficients are zero for all three ranges. No flag override was used as a workaround.

The corrected production boundary matched **864 full native MT_Process_OL cases exactly** across ranges0/1/2, including responsivity state, blackbody temperature, final object temperature and status. Reproduce with `scripts/research/compare-radiometry-state.py` for each range. The lower-level2,916-case function comparisons remain valid for their supplied inputs; they never proved the prior SDK distance interpretation.

For the saved fixed-view first frame in `test-output/temperature-pair/2026-11-07T18-05-38-171Z-recording-WYPvzB`, the distance fix yields center16.02°C, high18.62°C and low14.99°C. This improves the discrepancy but remains below the user's phone reference (high23.06°C, low18.72°C). No empirical offset was added; remaining host/reference-state investigation is separate. Physical accuracy remains unvalidated.

## Desktop measurement parameters

The application persists an explicit environment in preferences and supplies it to every new radiometry instance. Changing it while idle validates and saves the complete configuration before replacing live state. Held temperature samples and queued enhanced previews are invalidated so readings computed with old parameters cannot reappear. Capture/log sessions lock these settings; their metadata and CSV retain the configured air temperature and humidity. A unit-only preference change preserves all environment settings.

The emissivity presets are transcribed from the user-provided iOS settings screenshots, not independently measured material constants. The matching preset identifier is persisted alongside emissivity; editing its numeric value selects Custom. Distance is converted from the chosen display unit to canonical meters before the separately verified native SDK encoding.

Distance describes the path between camera and target and affects atmospheric compensation. Emissivity and reflected temperature are generally the more important parameters at short distances; see [FLIR measurement-parameter documentation](https://docs.flir.com/T810664/en-US/latest/s08.html).

2026-11-07 live check with emissivity0.91, distance0.9144m, air/reflected20°C and60%RH produced high18.27°C / low14.43°C. The earlier phone view showed high23.06°C / low18.72°C. This is not a simultaneous reference measurement and no empirical offset has been applied. Remaining SDK initialization/shutter-reference behavior is being investigated.

## AY1 initialization evidence and remaining configuration limits

The SDK distance-boundary regression also executes the original MicroTA packing instructions under Unicorn: center-point `0x9c5d8..0x9c68c` and region-point `0x9e3b4..0x9e3cc`. Nine UI distances (0.2 through 100 meters) match `encodeSdkDistance` exactly after Q13 truncation. Local evidence is `research/temperature-diagnosis/microta-distance-reference.json`.

AY1 constructor `0x1f4fac` calls base constructor `0x210a34` at `0x1f5014`, then installs vtable address point `0x2bc120`. The base constructor clears 0x308 bytes from object+0x724 (`0x210ae8..0x210af4`), including flags +0x745/+0x746. AY1's virtual initialization +0x260 resolves to `0x1fde18`; it clears +0x724 through +0x827 again and sets only +0x72e within that block. In contrast, sibling implementations read a device block. AY1's TempInit getter `0x1fbfcc` derives the flags ultimately passed as MT parameters 45, 55 and 57 from these zero-initialized bytes. This establishes the default flags as zero; it does not rule out every subsequent user configuration change.

The AY1 environment initializer loads 16 bytes from ELF virtual addresses 0x7a9e0 and 0x7a878, then sets byte4 to50. The resulting bytes are `00200300320000000020000000800200`. The corresponding MeasurementEnvParams fields are ambient25 C (Q13), relative humidity50%, optical transmission1 (Q13), and optical temperature20 C (Q13). Optical temperature is not the separate reflected-temperature rule field. Getter vtable+0xa8 resolves to `0x1fdec8` and returns this cached structure. Complete propagation from this getter to the live calculator has not yet been established; the application therefore retains its explicit configured environment rather than silently replacing it from this partial trace. The Java live rule update preserves the existing rule's reflected temperature while changing emissivity and distance. Its actual initial reflected temperature remains unresolved.

A bounded NUC offset audit found writes to handle+0xde only in generic initialization, SetParam key16 (`0x1b51c..0x1b528`), and selected per-gear resource loading (`0x1eba8`/`0x1ebb4`). The examined MicroDM SetConfig callsites do not issue key16; background acquisition does not change the offset. This does not support changing the selected8192 offset to force its calculated reference temperature to equal current sensor CAV. CAV is a sensor/die measurement, not an independently measured shutter radiance temperature.

After fixing the distance boundary, the saved paired view still differs from the phone reference. Arithmetic agreement with native library functions validates those functions for supplied state; it does not establish full live-state equivalence or physical accuracy. No additive temperature adjustment has been fitted to the phone image.

# SK02 shutter background acquisition

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

This note isolates verified acquisition arithmetic from the still incomplete host shutter controller. All addresses refer to the inspected ARM64 `libifrnuc.so`; no hardware was accessed for these experiments. The actual sensor code `065356A000` selects processor enum1, which shares resource VA `0x101c690` with enum2. Its three gear records start at resource offsets67/95/123 and each begins with count16. `IFR_NUC_UpdateNucParams` copies the selected internal record's first byte into handle+`0x60a` and +`0x60b` at `0x1eb54–0x1eb60`. Subsequent runtime setters can override this configuration.

## Verified accepted-frame stage

`IFR_NUC_Cali_BCaliInit` (`0x2117c`) clears accepted-frame count+`0x60e`, completion bit2 of +`0x60f`, and the uint32 accumulation plane at pointer+`0x620`. `IFR_NUC_Cali_BCaliSendRawImg` (`0x211c4`) receives a structure containing raw-plane pointer, signed sensor sample at+8 and two state bytes at+10/+11, plus an in/out phase byte pointer.

For each call accepted into this routine, count increments and every unsigned16 raw pixel is added to its unsigned32 sum (`0x21328–0x2134c`). At count16, completion bit2 is set and the phase becomes2. Calls beyond16 return before further pixel accumulation (`0x21308–0x21318`). This does **not** prove that the first16 camera frames after a shutter command are eligible: the upstream controller decides when to call this routine.

The two background representations have different precision:

| Result | Native operation | Evidence |

|---|---|---|

| Reference image plane A/B/C | `uint16(sum / 16)` using unsigned integer division | A: `0x21540–0x21580`; B: `0x21730–0x21770`; C: `0x217e8–0x21828` |

| Current quarter-count correction background | `uint16(sum / (16 >> 2))` | `0x21a04–0x21a94` |

Thus `floor(sum/4)` preserves quarter-count fractions that would be lost by first averaging to integer detector counts and multiplying by4. Conversion to uint16 follows division and wraps the low16 bits. The image-wide mean at+`0x680` uses each quarter-background value shifted right2, a truncated Q32 reciprocal of pixel count, and half-up rounding (`0x21aac–0x21ad0`); it is not an ordinary floating mean.

## Sensor baseline

During acquisition, sensor samples are retained at pointer+`0x158`. On the16th call, sample index7 is the anchor. For each sample, native code computes a **signed16 wrapped difference** from this anchor; absolute differences at least3 are replaced by the anchor. It sums the resulting signed samples and divides by16 with truncation toward zero (`0x21270–0x212cc`). The result becomes shutter baseline+`0x69c`.

When input byte+11 is1 and acquisition-state+`0xed` is already nonzero, completion overrides that baseline with the signed average of the last16 entries in the separate32-entry sensor history at pointer+`0x150` (`0x21370–0x214cc`). This override does not apply the acquisition outlier filter again. A caller must select this branch from actual state, rather than choose whichever average looks plausible.

## Reference-plane and readiness state map

The mode1 dispatch at `0x21500` uses state+`0xed` and jump table VA`0x39f30`:

| State | Target | Observed behavior after acquisition |

|---|---|---|

| 0 | `0x21514` | Store average in A(+`0x650`), sensor in+`0x696`, advance to1. |

| 1 | `0x215c8` | Once the relevant sensor-change threshold is met, store average in B(+`0x658`), sensor in+`0x698`, advance to2 and mark the matching gear ready when captured type is1. |

| 2 | `0x21608` | Input byte+10 equal1 stores C(+`0x660`) and sensor+`0x69a`, advancing to3. Other paths update/roll A/B according to drift span and flags. |

| 3 | `0x21690` | Sufficient change from C replaces A with C and B with current average, updates paired sensors, returns to2 and sets phase5. |

The relevant input/state includes captured gear+`0x610`, captured type+`0x611`, current gear+`0x22`, current type+`0x24`, threshold/state bytes+`0x123`, +`0x148`, +`0xee`, +`0xf4`, +`0x11c`, and per-gear ready bytes+`0xf0/+0xf1/+0xf2`. A gear/type mismatch resets acquisition-history flags and background-slope baseline (`0x213b8–0x21460`); this routine alone does not reset the pixel accumulator. The upstream initialization and transition sequence therefore matters.

Drift-map construction consumes A/B as **integer-count planes**, while correction consumes the separate quarter-count plane. The mean-background slope uses another pair of image means and sensor values at+`0x682/+0x684/+0x686/+0x688`, with its separate48-unit update criterion. See the existing [NUC investigation](nuc-investigation.md) for those formulas. These state variables are not interchangeable with the pixel gain matrix or a generic flat-field image.

## Offline helper and native comparison

`src/core/shutter-background.cjs` exports `summarizeAcceptedShutterFrames`. It requires exactly16 already accepted raw planes,16 sensor samples, and an explicit baseline branch. It returns sums, integer reference, quarter-count background, image mean and sensor baseline without changing inputs. It performs no USB/shutter action, makes no frame-eligibility decision, marks no gear ready and is now composed by the live factory processor.

`scripts/research/shutter-background-oracle.py` reuses the bounded, SHA-checked Unicorn loader to call the actual `IFR_NUC_Cali_BCaliInit`, `IFR_NUC_Cali_BCaliSendRawImg` and `IFR_NUC_Cali_BCaliCalcBMatrix` routines on synthetic arrays. Ten cases, each16 frames by17 pixels, match the JavaScript helper across both baseline branches. An additional17th call is verified not to alter completed accumulation. The later drift-state phase is explicitly disabled for this arithmetic comparison; the experiment does not validate the full shutter controller.

Run the Python oracle, then `node --test test/shutter-background.test.cjs`. Four standalone tests cover precision, narrowing, baseline rejection/truncation and missing-state failures; a fifth compares generated native vectors when present. Research dependencies and generated vectors remain local and ignored.

The selected startup correction branch has now been ported and compared through NUC, FPN, BPC and VC on own saved raw frames. This does not complete the host controller's settling/freeze counters, eligibility gates or subsequent A/B/C plane-roll transitions. The app explicitly selects16 frames inside its confirmed closed-shutter window and records that this eligibility is not the entire native controller. See [factory startup pipeline](factory-startup-pipeline.md).

## Bounded paired-view timing audit, November 7, 2026

The application does not treat its `closed` event as a physical-position sensor. The helper sends the verified down command, waits100ms, releases the drive, waits100ms, then emits `closed`. It holds this stage for1200ms before up/release. The application accepts frames received150..1000ms after that event and uses the last16. Host delivery/buffering time and mechanical travel are not separately measured. The latest saved control log records `closed` at18:20:33.2669183Z, `opening` at18:20:34.4900609Z, and `opened` at18:20:34.6889373Z. Twenty raw reference frames were saved.

An offline check evaluated every consecutive16-frame window in those20 saved frames against the same saved snapshot. Configured emissivity was0.91, distance0.9144m, ambient/reflected20C and humidity60%. Center varied only15.6600..15.6746C, high18.2697..18.2839C and low14.4273..14.4568C. Every window produced sensor baseline1606; individual CAV samples were1606 or1607. This rules out first-versus-last16 selection within this particular captured window as an explanation for the remaining several-degree phone discrepancy. It does not establish what happened before that saved window, measure shutter temperature, or prove native timing equivalence. Exact results and raw-frame statistics are in ignored `research/temperature-diagnosis/shutter-window-comparison.json`; sources are the18:20:34 shutter reference and18:20:38 snapshot under `test-output/measurement-parameters`.

The resource count16 is not universal across all controller branches. `NUC_ShutterCtrl` checks +0xfc; the path with +0xfc==0 and +0x113==1 clears the accumulation plane, invokes a callback, and explicitly writes8 to acquisition count+0x60a (`0x226a4..0x22720`). Later phase/callback flags (+0x101/+0x109/+0x10a/+0x10e) decide when frames reach the acquisition routine. One path calls callback+0x7a8 with1 and sets acquisition-enable+0x10a only after success (`0x2302c..0x23048`); other paths additionally wait for a callback status. Fully reproducing this host state machine requires its actual initial state and transitions, not merely replacing16 with8 or shortening the shutter hold.

Remaining work: establish the active first-cycle branch and frame eligibility from full native processing state; propagate actual live environment and reflected-rule initialization into the calculator; check subsequent native reference/drift transitions. The current acquisition arithmetic is verified for explicitly accepted frames. Neither the timing audit nor the native arithmetic comparisons validate absolute physical accuracy. No temperature offset was fitted to the phone reference.

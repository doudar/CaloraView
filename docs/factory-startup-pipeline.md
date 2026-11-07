# Factory startup correction pipeline

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

The live SK02 processor uses this camera's verified KMatrix2, BPM, VC and thermometry exports. No vendor image or another unit's factory calibration is substituted. Files are checked against the serial-bound export manifest again when loaded.

The selected sensor identity `065356A000` has processor enum1, detector dimensions256 × 192, default range selector3 and NUC offset 8192. The transport image is264 × 222; the detector crop begins at x4,y2. Metadata word5 remains1 and word13 is2. These values belong to different native fields.

## First-reference correction

A first shutter reference can produce corrected output before two temperature-separated reference planes exist. `NUC_TECLESS30_Process` follows acquisition state1, no ready drift gear and flag+0xf3=0 through `0x1f5b8 → 0x1f8ec → 0x1fa88 → 0x1ff60`. The startup correction at `0x1ffec–0x20010` is:

```text
clamp14(8192 + floor(((raw * 4 - backgroundQuarter) * KMatrix2) / 131072))
```

The multiplication is wide signed arithmetic, not the older mode0 wrapped32-bit multiply. Native16-frame acquisition constructs quarter-count background as floor(sum(raw)/4); the corresponding integer reference is floor(sum(raw)/16). The acquisition CAV baseline applies the verified anchor/outlier rule. See [background investigation](shutter-background-investigation.md).

The factory processor then runs FPN, isolated bad-pixel correction and stateful vignetting correction, in that order. Actual BPM records identify pixels(170,0) and(13,77); clustered defects are rejected because the extended native neighbor search is not yet ported. The actual VC plane is98304bytes, SHA256 `ec128a602016ed6903284f2565074029ef02aaa1f09d06b241df6319c94e0942`. A missing VC plane does not silently become a zero map.

## Eligibility and limits

`setShutterReference(rawFrames,{shutterClosed:true})` requires16–64 complete frames and uses the last16 from the caller's confirmed closed window. The app currently supplies frames150–1000ms after the verified closed event. This is an explicit app acquisition policy, not a claim that every native shutter controller transition was reproduced. Returned provenance records `nativeControllerEquivalent:false`.

Frames are excluded during shutter activity, for missing/unsupported CAV, detected native invalid patterns, absent reference/VC, or a CAV baseline difference of at least13 counts. The startup branch's warning is checked before publishing temperatures. A new reference can restore this bounded startup mode; this does not yet implement the native later A/B/C drift model or every gear transition. The startup warning threshold is not automatically the native timed shutter policy.

FPA is synthesized from the cropped border samples with native float32 operations; CAV drives NUC and this unit's normal thermometry response. Normalized header writes preserve unrelated metadata. Aggregate and secondary host validity fields are distinct; both are zero for eligible frames. Invalid metadata is withheld from temperature publication.

## Native comparisons

`scripts/research/factory-startup-oracle.py --calibration <verified-eight-file-folder>` executes the actual ARM64 library offline under the bounded Unicorn loader. It feeds the same last16 own shutter frames into native acquisition, then compares NUC → FPN → BPC → VC against the production factory processor on five own scene frames. VC history is retained on both sides.

The comparison matches all 245760 pixels. Gear3, offset 8192 and baseline 1584 agree; native invalid and drift flags are zero throughout. The generated local evidence is `research/factory-startup-own-capture-reference.json`. Independent FPA comparison matches 118 cases; individual FPN, BPC and VC comparisons exercise additional synthetic boundaries.

These results establish native numerical equivalence for the tested startup branch and saved inputs. They do not establish physical temperature accuracy against a traceable target, long-duration drift behavior, all SK02 firmware variants, or the complete Android application state machine. Radiometry and environmental compensation have separate native comparisons described in [radiometry investigation](radiometry-investigation.md).

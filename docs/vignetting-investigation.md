# Portable vignetting correction

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

`src/core/nuc-vignetting.cjs` implements the inspected software VC branch for a256×192 signed16 matrix and16×16 blocks. It is independent JavaScript and loads no vendor library. `new VignettingCorrection(map).process(image)` returns `{corrected, alpha}` without changing the input image. The matrix is copied. `setMatrix` preserves prior alpha as the native function does; `reset()` explicitly clears history. Integration should construct a new instance for each processing session and use the device's verified map or the specifically established vendor fallback.

Native evidence (`libifrnuc.so`, inspected ARM64 build):

- `IFR_NUC_Cali_VignettingCorrection_SetMatrix` 0x31718, software branch0x3183c, copies exactly pixelCount×2 bytes when the setup gate permits, then calls template initialization. The portable class performs this authorized matrix assignment directly; hardware callback and nonsoftware mask branches are outside its scope.
- `IFR_NUC_Cali_VignettingCorrection_TemplateMatrixInit` 0x31464 computes each signed block mean with float32 division and floor, then signed16 horizontal differences. Each row's first gradient is zero. The denominator is max(1,sum of gradient squares); threshold is trunc(1.5×largest absolute gradient), stored uint16.
- `NUC_VignettingCorrection_CalcAlpha` 0x2fecc computes unsigned image block means with integer division. For columns after the first, signed16 adjacent differences contribute only when absolute difference is strictly below the selected threshold. Correlation is a signed64 sum of image difference times map gradient. The Q20 estimate is signed truncating division of correlation shifted20 by the template denominator. Native32-bit wrapped smoothing uses16/512 by default, replacing an initial zero history with the current estimate, then clamps to±4194304.
- `NUC_VignettingCorrection_Process` 0x3018c subtracts the signed Q20 product from each pixel. It narrows to unsigned16 **before** clipping to16383: negative intermediate pixels wrap high. The port intentionally preserves this behavior. The optional forced-alpha parameter path is not exposed; normal resource defaults use the estimated alpha.

The standalone oracle `scripts/research/nuc-vignetting-oracle.py` uses the shared research loader and full native NUC handle, but only synthetic maps/images. Six maps×five successive frames matched the native template, alpha state and all **1,474,560 pixels exactly**. Maps include zero, ramps, fine spatial variation, signed16 extremes, a curved field and constant−1. Frames cover correlated/anticorrelated scenes, large gradients and values near zero and16383. Unit tests store only synthetic output hashes, verify history/reset and input immutability, and exercise strict threshold exclusion and negative block mean flooring.

## Embedded fallback

The MicroDM static-data path at0x201bd4 calls0x27fc74, which returns virtual address0x101cb95 and length131072. In the inspected ELF, file offset is VA−0x8000. Independently reading that131072-byte region confirms every byte is0xff. The first49152 signed16 entries are therefore all−1. Its gradients and computed alpha are zero, so native VC is identity for14-bit input. The native oracle includes this exact constant-map case.

This fallback evidence does not justify interpreting any missing cache file as a device read failure. The caller must establish the APK-equivalent fallback condition from an actual bounded VC export attempt and record the result. Transport and cache validation own that decision; this math class has no USB or cache behavior.

```powershell
python scripts/research/nuc-vignetting-oracle.py
node --test test/nuc-vignetting.test.cjs
```

The oracle uses locally extracted files under ignored `research/`, Unicorn2.1.4 and pyelftools0.33. It inherits the verified library hash and per-call instruction limit from `nuc-tecless-oracle.py`; this is not a wall-time timeout. No proprietary matrix is committed or used by the synthetic tests.

## Actual camera map validation

A subsequent direct read obtained this camera's98304-byte VC table, SHA256`ec128a602016ed6903284f2565074029ef02aaa1f09d06b241df6319c94e0942`. The same native differential check passed its template initialization, alpha history and all245760 pixels in five fresh synthetic scenes. Combined with the six synthetic maps, the run covered35frames and1720320pixels with no differences. The actual table remains local under ignored `research/`; it is not copied into the tests. A verified actual table takes precedence over the documented fallback.

```powershell
python scripts/research/nuc-vignetting-oracle.py --matrix research/factory-tables/vignetting-direct/VC-ec128a602016ed69.bin
```

The optional actual-map run writes `research/nuc-vignetting-reference-actual.json`, including the map hash; synthetic-only reference remains separate.

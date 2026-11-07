# SK02 host metadata rewrite

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

This bounded static trace uses the APK's ARM64 libraries and the saved identity

response from camera `A43EB0_EXAMPLE`. No device commands were issued. The

header helper is now used by the factory processor. The metadata alone is not

a complete radiometric frame; see [factory pipeline](factory-startup-pipeline.md).

## Actual sensor enum and dimensions

The device sensor string `065356A000` maps to processor enum **1**, despite the

raw adapter's name `DetectorRawLayoutF2Adapter`. These are distinct enum/name

domains: the `2` in F2 does not establish processor enum2.

AY1 vtable address point `0x2bc120`, slot `+0x2e8`, resolves through relocation

`0x2bc408` to `getAY1DeviceInfo` at `0x2079a0`. Its sensor comparison constants

are constructed by the static initializer:

| Global C++ string | Construction | Value | Processor enum |

| --- | --- | --- | --- |

| `0x104dba0` | `0x20e6f4–0x20e718`, eight bytes from `0x5c75f` plus `00` | `2653580000` | 0 at `0x207b7c` |

| `0x104dbb8` | `0x20e720–0x20e744`, eight bytes from `0x62712` plus `00` | `065356AA00` | 2 at `0x207c0c` |

| `0x104dbd0` | `0x20e74c–0x20e770`, eight bytes from `0x73095` plus `00` | `065356A000` | 1 at `0x207ef0` |

`0x207fac` obtains the identifier from cached device info at `+0x84`, taking

the suffix after the final underscore. `0x20a8cc` invokes the virtual getter;

`0x20a900/0x20a914` transfers output `+4` into constructor configuration `+8`.

The constructor stores that enum at processor `+0x284` (`0x226228–0x22622c`).

The configured resolution comes from configuration `+0/+4` at `0x226204–0x226208`,

supplied by resolution getter `0x1fa81c`.

Only enum2 overrides metadata dimensions to width192/height144. For this unit's

enum1 the rewrite uses configured width256/height192, consistent with its

verified raw crop and 49,152-element factory planes. The rewrite itself does

not transpose, rotate or mirror pixels. Display rotation must not silently

change metadata dimensions or corrected pixel order. The entire later

orientation path is not implemented by this helper.

## Exact writes before NUC

Additional rows start at USB row216. F2 copier `0x25f6d8` copies six 512-byte

rows with source stride528, producing3,072 meaningful compact bytes. The raw

USB is separately retained. In function `0x23ca40`, x20 is the additional shared

block (`0x23ca68`); its data pointer is loaded through `[x20]`.

`0x23dd3c–0x23dda4` performs these uint16 little-endian writes **before**

`IFR_NUC_Process`, called at `0x2406bc`:

| Word | Byte offset | Written value | Evidence |

| --- | --- | --- | --- |

| 0 | 0 | Synthesized FPA word | `0x23dc00–0x23dc0c` truncates float32 estimate to integer, multiplies50; `0x23dd54` stores low16bits |

| 5 | 10 | Constant1 | `0x23dd44`, `0x23dd64` |

| 8 | 16 | Configured height192 here | `0x23dd4c`, `0x23dd60`, `0x23dd84–0x23dd88` |

| 9 | 18 | Configured width256 here | `0x23dd94–0x23dd9c` |

| 13 | 26 | Processor byte `+0x2d8`, minus1 | `0x23dd68–0x23dd78` |

| 20 | 40 | Cached CAV word | `0x23dd98`, `0x23dda4` |

The actual sensor's default range record selects processor selector3. AY1

`0x1f5e74–0x1f5f20` caches the third range; getter `0x1ffb64` returns it.

Initialization `0x20ae28–0x20ae50` calls `0x2315c0`; `0x2318b8–0x2318e0`

sets NUC parameter513 to3. This selects offset 8192 and KMatrix2 (`0x23ef4c–0x23ef64`),

and writes word13=2. This is distinct from metadata word5=1.

FPA is calculated from the cropped 256 × 192 detector plane before gain correction.

Resolution constants at `0x7aa50` and `0x7a8c0`, loaded by `0x1fac8c–0x1faca0`,

separate detector dimensions from the264 × 222 transport. Call `0x23d6d4–0x23d700`

passes the contiguous detector image, width, height, width×2 stride, and enum1.

The calculation samples cropped column255 at rows0,10,...190: raw column259,

rows2,12,...192. It is not established that these pixels are optically masked.

`src/core/nuc-startup.cjs` reproduces float32 mean and fused multiply-add,

then integer truncation before multiplication by50. The estimate itself is not

smoothed. The diagnostic prior estimate at processor+0x31c is separate.

The bounded native oracle matches 118 cases (112 own captured frames and six

constant boundaries). CAV, rather than synthesized FPA, drives this unit's

selected NUC sensor baseline. A zero incoming CAV makes a live frame ineligible:

using cached word20 cannot replace word1 consumed by the radiometry stage.

## Validity after NUC

The `IFR_NUC_Process` output structure at `sp+0x110` is not the additional-row

buffer. Its `+0xa` is an optical-center coordinate, not metadata gear word5.

At `0x24193c–0x241970`, MicroDM combines several host/shutter/NUC conditions.

It writes aggregate register w25 as uint16 at byte12 through `0x241e2c`.

The uint32 field at byte540 is **separate register w24**, written at `0x241e44`.

That value comes from output byte1 of helper `0x26b288` at `0x241164`, or zero

when the corresponding processor is absent (`0x2413a8`). It is one input to the

aggregate, so both fields are zero on eligible frames; they need not be equal

on invalid frames. This corrects the earlier claim that both writes use one register.

`applyResolvedHostValidity` represents the fields separately. Its default sets

both to the supplied application invalid flag. That conservative exclusion is

not a port of all native invalid-state transitions. Word7 remains untouched.

The complete native host/shutter controller is still distinct from the app's

confirmed closed-shutter window and startup correction branch.

## Subsequent native online preparation

MicroDM calls `AddLinesCalculator::calculate` at `0x2395f4`. MicroTA `0xc8d4c`

configures parameter29 from its caller's explicit value, concatenates image

and additional block (`0xc8df8–0xc8e6c`), then invokes

`MT_SetConfig_OL(handle,7,combined,size)` at `0xc8e80`. On success it copies the

additional portion back (`0xc8e90–0xc8ea0`). This path is conditional on the

calculator's enabled flag and valid handle (`0xc8d78–0xc8d94`).

MTlib's jump table at `0x23084` maps command7 to `0x699c`, which requires at

least `width*(height+2)*2` bytes and calls `MT_SetCoreParam` at `0x69c4`.

`MT_SetCoreParam` (`0xc138`) parses appended metadata, applies additional row2,

calls `MT_SetBaseGray` with the image (`0xc2a4`), and calculates atmospheric

transmission (`0xc2b4`). A metadata-only `MT_SetAddlParam` success therefore does

not prove this image-dependent preparation has been reproduced. The oracle's

previous diagnostic outputs remain explicitly incomplete.

## Helpers and checks

`src/core/host-metadata.cjs` extracts all six rows and performs the verified

header/validity writes. The research path reexports it for compatibility.

It requires the known sensor identity and explicit host state, preserves other

bytes and never mutates inputs. The separate export validator binds factory

files to the actual camera serial and device identity.

Run `node --test test/host-metadata.test.cjs`. Tests cover stride/padding,

changed bytes, independent validity flags, input immutability, and invalid states.

The factory pipeline now supplies synthesized FPA, default selector3 and corrected

pixels; native numerical comparisons and physical temperature accuracy remain

different forms of validation. See the [factory pipeline](factory-startup-pipeline.md)

and [radiometry investigation](radiometry-investigation.md).

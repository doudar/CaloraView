# SK02 focus capability

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

The official SK02 specification, page 3, states **Focus Mode: Focus Free**, minimum focus distance **0.2 m (0.66 ft)**, and lens focal length **3.5 mm**. The table was checked both by text extraction and rendered-page inspection. This identifies focus-free optics rather than a motorized autofocus/manual-focus feature. A software focus slider would not move this camera's lens. Sharpness enhancement is a separate image-processing operation.

Primary source: [manufacturer SK02 specification](https://cdn.shopify.com/s/files/1/0794/4329/6500/files/AccuMEMS_SK02_Spec_260920.pdf?v=1790074777), linked by a `data-link` attribute from the [official download center](https://www.accumems.com/pages/download-center). Local preserved PDF: `research/manufacturer/AccuMEMS_SK02_Spec_260920.pdf`; rendered table: `research/manufacturer/sk02-spec-page3.png`.

## Saved USB descriptor corroboration

No new device commands were issued. The previously captured 212-byte configuration descriptor contains this 18-byte Camera Terminal at offset 0x27:

```text
12 24 02 02 01 02 00 00 00 00 00 00 00 00 03 00 00 00
```

It is terminal ID2, type 0x0201, bControlSize 3, with `bmControls=00 00 00`. Thus Focus Absolute(D5), Focus Relative(D6), and Focus Auto(D17) are not advertised. The [Linux UVC documentation](https://docs.kernel.org/usb/gadget_uvc.html) confirms these bitmaps declare supported controls and identifies 0x60 as absolute/relative focus support. The [Ocean UVC descriptor implementation documentation](https://facebookresearch.github.io/ocean/doxygen/class_ocean_1_1_system_1_1_u_s_b_1_1_video_1_1_v_c_input_terminal_descriptor.html) enumerates D5/D6/D17.

Zero standard UVC bits alone would not exclude a vendor extension control; the manufacturer's explicit focus-free specification supplies the independent optical evidence. Generic native SDK symbols for focus are shared across other devices and are not proof of SK02 capability.

## APK model-gated help

`HelpEntityKt.getHelpConfig` includes manual focus-ring help only when the module ID is in `p089h4.f.o()` or `.l()`. Those methods return lists `f29419g` and `f29420h`:0953560101,0953560105,0953060002,0953510000,0953510100. The actual SK02 module 065356A000 is absent from both. It appears separately in `f29414b`. This is consistent with the official focus-free specification; the APK's generic focus-ring string does not apply universally to every model.

The camera and running app were not disturbed. No guessed focus request was sent.

## Evidence hashes

- `research/manufacturer/AccuMEMS_SK02_Spec_260920.pdf`: SHA256 `3a554831ef61d60395f981606134d41428f2ab60f2c8a8eed6746b37a53bccae`.
- `research/usb-descriptors/38be-0184-0.bin`: SHA256 `f2fc263d7ab923e48b206b3a0353968738cc128a00c7fddb19f86acde5c54164`.

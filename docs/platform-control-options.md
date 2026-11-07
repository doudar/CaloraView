# Platform control transport options

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

Research date: 2026-11-07. This investigation made no driver, device, or system changes. It distinguishes documented API behavior from the SK02 observations and hypotheses.

## Windows: retain usbvideo.sys

**Current result:** the existing `usbvideo.sys` driver now successfully exports this SK02's factory tables through KS. Removing redundant zero-buffer property sizing queries and using recovered explicit transfer lengths produced files with the same SHA-256 hashes as Android's direct USB export. No driver replacement or new transport API was needed. The earlier search found no documented application call that forces an arbitrary raw UVC `GET_LEN`; the successful path does not require one.

Microsoft maps extension-unit control selectors to properties in the unit's GUID property set. During device initialization, `usbvideo.sys` issues `GET_INFO`, `GET_LEN`, `GET_MIN`, and `GET_MAX`. The documented `KSPROPERTY_EXTENSION_UNIT_PASS_THROUGH` identifier is explicitly unimplemented; its existence in a header is not a usable USB setup-packet escape hatch. [Microsoft: device requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/device-requirements-for-usb-video-class-extension-units)

`IKsControl::KsProperty` accepts a property request and an application buffer. Its documented sizing operation uses a null data pointer and zero buffer length, returning the required property buffer size through `BytesReturned`. It does not specify that sizing generates a new USB transaction. A larger application buffer likewise does not document an override of the driver's USB `wLength`. [Microsoft: KsProperty](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ks/nf-ks-ikscontrol-ksproperty)

Microsoft's historical XU plug-in sample implements `get_PropertySize` with precisely that null-buffer KS GET. A COM plug-in therefore wraps KS properties; it does not add a raw USB transport. The sample is marked outdated and unsupported, so it is architectural evidence rather than a current build recipe. [Microsoft: sample plug-in](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/sample-extension-unit-plug-in-dll)

Do not conflate the following:

| Operation | Documented meaning | What remains unproven here |
| --- | --- | --- |
| Zero-buffer KS GET | Obtain required property buffer size | Whether it sends fresh USB `GET_LEN` |
| XU property ID 0 | Return descriptor-derived information cached at startup | It is not a runtime length refresh |
| KS basic-support query | Describe property support and ranges | No documented raw request selector or length-refresh mechanism |
| Recreate the COM filter/node | Obtain a new application-side object | No documented invalidation of `usbvideo.sys` control sizes |
| Direct `IOCTL_KS_PROPERTY` | Submit a KS property request | No documented bypass of the same property handler |

The descriptor cache is explicitly documented for ID 0. It does **not**, by itself, prove how control-value lengths are cached. [Microsoft: XU information property](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/ksproperty-extension-unit-info) Basic support and the KS IOCTL remain property interfaces. [Microsoft: XU plug-in architecture](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/extension-unit-plug-in-architecture), [Microsoft: KS properties](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/ks-properties)

### What the SK02 evidence actually establishes

Our recovered native SDK calls raw USB `GET_LEN` (`0x85`) before transfers, using a vendor-specific four-byte response buffer. Its chunked factory-source selection sends a five-byte length announcement followed by a thirteen-byte packet; the latter retains its computed length even after calling `GetDataLen`. See [protocol investigation](protocol-investigation.md) for exact addresses and bytes.

The Windows KS helper reports property size five for selector 26. Earlier reads returned zero bytes, even with a 512-byte diagnostic buffer. The subsequent **2026-11-07 15:34 UTC trace changes that evidence**: the normal five-byte GET still returns zero, but the final diagnostic GET requests and receives 512 bytes (`02 01 00 00 00` followed by 507 zeros in the application report). This is an untrusted diagnostic packet after the failed size phase, not a downloaded calibration table. Results from different runs must not be merged.

The completed header trace directly shows fresh two-byte USB `GET_LEN` transactions before the relevant operations, disproving the missing-fresh-query explanation for this run. It also shows selector 5 SET requests reduced from the application's four bytes to USB `wLength=2`; selector 26 SET requests of five and thirteen application bytes reach USB with `wLength=0`. The normal five-byte GET also reaches USB with zero length, while the 512-byte diagnostic reaches USB with length 512. Both dispatch and completion events agree. Source evidence is `research/factory-tables/trace-20261107-153423-2dcf230826ac41d3a8a7fdc7ceac1451/headers-relaxed.xml`, `sk02-control-headers.json`, and `factory-download-20261107-153424-791.json`.

The trace proves the SDK's desired source-selection payload was not transmitted by the tested KS path. It does not expose `GET_LEN` response payloads or establish why the driver chose those lengths. In particular, native four-byte `GET_LEN` versus Windows two-byte `GET_LEN` is now a concrete difference to investigate, not a proven firmware incompatibility. The C# `IKsControl` declaration and 32-byte `KSP_NODE` layout match the installed Windows SDK 10.0.26100.0 `ksproxy.h`/`ks.h`: GUID at 0, selector at 16, flags at 20, node at 24, reserved at 28; data pointer and ULONG lengths are passed separately. No concrete marshaling defect was found in the reviewed helper. Successful four-byte version and 488-byte identity transfers further argue against a general pointer or length-signature problem.

The Android direct-control exporter subsequently succeeded, using four-byte `GET_LEN` and exact five/thirteen-byte source packets. Its transcript exposed an additional difference: Windows' explicit zero-buffer sizing query generated a `GET_LEN`, then the actual KS transfer generated another. Removing those redundant application sizing queries and using the recovered exact lengths made Windows exports succeed too. BPM, KMatrix, KMatrix2 and thermometry calibration hashes match across the two independent transports for serial `A43EB0_EXAMPLE`. Android originals are under `research/sk02-device-export-20261107/files`.

The effective Windows fix is observed. The inference that repeated `GET_LEN` advances or perturbs firmware phase is plausible from the transcripts, but the firmware implementation has not been inspected. The two-byte/four-byte GET_LEN distinction alone is therefore not an established blocker. Keep known packet lengths and the bounded protocol state transitions in the helper; do not reintroduce zero-buffer sizing for this transaction sequence.

USB header tracing observes transactions without collecting transfer payloads when only `HeadersBusTrace` is enabled. It cannot reveal the returned length value's bytes. [Microsoft: USB event tracing](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/how-to-capture-a-usb-event-trace) The bounded script is [trace-factory-headers.ps1](../scripts/protocol/trace-factory-headers.ps1).

### Alternatives that change the constraints

WinUSB requires `Winusb.sys` as the function driver. Microsoft's supported multifunction arrangement permits a different driver per USB function, not two function drivers on the same function. Consequently, calling WinUSB from this app is not a documented side channel to the existing video function. [Microsoft: desktop USB applications](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/windows-desktop-app-for-a-usb-device)

`IOCTL_INTERNAL_USB_SUBMIT_URB` is a **kernel-mode** request to the USB hub PDO, not a user-mode ioctl that can be passed to the camera handle. A purpose-built driver/filter would be a separate deployment and compatibility project, outside this investigation. [Microsoft: submit URB](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/usbioctl/ni-usbioctl-ioctl_internal_usb_submit_urb)

## macOS: possible direct controls, unresolved ownership

Apple's user-space **IOUSBHost** framework provides `IOUSBHostDevice` and `IOUSBHostInterface`, inheriting control-request methods from `IOUSBHostObject`. This is distinct from implementing a USBDriverKit driver. [Apple: IOUSBHost](https://developer.apple.com/documentation/iousbhost?language=objc), [Apple: IOUSBHostObject](https://developer.apple.com/documentation/iousbhost/iousbhostobject?language=objc)

`sendDeviceRequest:data:bytesTransferred:completionTimeout:error:` submits a request on the default control endpoint and reports the actual data-phase byte count. It accepts an explicit timeout; zero means no timeout and should not be used for our helper. This is a documented mechanism capable of expressing USB control requests, subject to obtaining access. [Apple: device requests](https://developer.apple.com/documentation/iousbhost/iousbhostobject/senddevicerequest%3Adata%3Abytestransferred%3Acompletiontimeout%3Aerror%3A?changes=_6)

Access is the unresolved issue. The initializer establishes exclusive ownership of the selected device/interface service and returns nil when it is already exclusively open. Documentation does not guarantee that an SK02 device-level connection can coexist with the services held by the macOS camera stack and AVFoundation. Whether different service levels permit this particular combination needs a real Mac test. [Apple: initializer](https://developer.apple.com/documentation/iousbhost/iousbhostobject/initwithioservice%3Aoptions%3Aqueue%3Aerror%3Ainteresthandler%3A)

`deviceCapture` is unsuitable as a coexistence fallback: it terminates existing device and interface clients/drivers, requires root or the specified virtualization authorization, and resets/re-registers the device when destroyed. It would interfere with camera capture. [Apple: deviceCapture](https://developer.apple.com/documentation/iousbhost/iousbhostobjectinitoptions/devicecapture)

The older IOKit `IOUSBLib` route is not evidence of unrestricted access either. Apple's header documents exclusive `USBDeviceOpen` ownership and requires an open device for `DeviceRequest`/`DeviceRequestTO`; the seize variant attempts to make another client close. [Apple: IOUSBLib header](https://github.com/apple-oss-distributions/IOUSBFamily/blob/main/IOUSBFamily/Headers/IOUSBLib.h)

### Future Mac proof, not implemented support

1. Validate byte-preserving AVFoundation capture first using [MACOS.md](MACOS.md).
2. Match the physical USB device using VID/PID and stable instance information; never use a generic camera name alone.
3. Try default, non-seizing IOUSBHost initialization and narrowly allowlisted read requests, first with capture stopped and then while streaming. Record access failures, actual lengths, frame continuity, and unplug cleanup. Do not detach, reset, reconfigure, or capture the USB device to force success.
4. Only if coexistence and byte preservation pass should the Mac helper implement serialized read-selection transactions or the separately verified shutter cycle. Serialize all controls with frame acquisition lifecycle changes and use finite request/process deadlines.

Successful direct reads with capture stopped would be useful for exporting factory tables, but would not establish live shutter support. No Mac hardware validation or control implementation has been performed, and no Celsius support follows merely from having a transport API.

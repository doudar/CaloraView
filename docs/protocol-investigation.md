# SK02 protocol investigation

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

Status: 2026-11-07. Static inspection of the user-provided AccuHeat V1.1.1 APK and its ARM64 native libraries; USB descriptors read from the attached SK02. No factory calibration, flash, firmware, driver, or camera-setting writes were performed for these findings. Addresses below are virtual addresses in the APK's exact library builds, not portable API identifiers.

## Live USB descriptors

`scripts/protocol/read-usb-descriptors.ps1` reads USB hub/connection information and standard GET_DESCRIPTOR only. `-CompileOnly` validates compilation without opening hardware. Windows sandbox access to hub handles is denied; running outside that sandbox succeeded. The helper does not replace `usbvideo.sys`.

Saved evidence: `research/usb-descriptors/38be-0184-0.bin` (212-byte configuration) and `.json`.

| Field | Live value |
|---|---|
| VID / PID | `38be:0184` |
| Extension-unit GUID | `a29e7641-de04-47e3-8b2b-f4341aff003b` |
| Extension-unit ID | 10 |
| VideoControl interface | 0 |
| USB control wIndex | `0x0a00` |
| Declared bNumControls | 15 |
| Enabled bitmap bits | selectors 1 through 32 |

The inconsistent declared count/bitmap must be checked against Windows KS property support. Windows exposes UVC extension controls through IKsControl with the extension GUID as property set and selector as property ID. The KS topology node ID is **not necessarily** the UVC unit ID. Discover it with IKsTopologyInfo. Source: [Microsoft extension-unit requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/device-requirements-for-usb-video-class-extension-units).

Live KS follow-up (decoder agent): XU is topology node2. Selector4 reports4bytes and returns `32 2e 30 00`, ASCII `2.0\0`. Exact read selection SET selector5 `02 05 01 00` followed by selector2 GET returned186bytes (`01` followed by185zero bytes); selector6 status returned`00`. These are transient query-selection writes, not persistent configuration. Artifacts: `research/ks-controls/`.

The hub descriptor IOCTL forces standard GET_DESCRIPTOR regardless of caller request fields, as documented by [Microsoft USB_DESCRIPTOR_REQUEST](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/usbioctl/ns-usbioctl-_usb_descriptor_request). `USB_NODE_CONNECTION_INFORMATION_EX` is packed: ConnectionStatus offset31, not32.

## F2 raw frame layout

The exposed stream is 264×222 words (117,216 bytes). Treat the YUYV transport as raw 16-bit words; ordinary YUV decoding destroys sensor values.

`libMicroDM_Release_v8a.so` contains RTTI for `DetectorRawLayoutF2Adapter` and `DetectorRawLayoutBase<DetectorRawLayoutF2,192,256,4,4,2,2,264>`. F2 vtable at `0x2bcab8`, typeinfo `0x2bcc10`, RTTI names `0x8a29e` and `0x8a2c6`.

| Region | Offset / dimensions | Evidence |
|---|---|---|
| Valid image | x4, y2, 256×192 | origin getter `0x25f3a0` returns base+`0x428`; copier `0x25f3c4` copies192 rows of512bytes with528byte stride |
| Body including masked pixels | 264×196 | getters `0x25f820`–`0x25f83c`; body copier `0x25f418` |
| Left mask | x0, y2, 4×192 | `0x25f788` returns base+`0x420` |
| Right mask | x260, y2, 4×192 | `0x25f7ac` returns base+`0x628` |
| Top mask | 264×2 | `0x25f7d0`–`0x25f7e8` |
| Bottom mask | y194, 264×2 | `0x25f7f0` returns base+`0x19020` |
| Dummy rows | start y196,20rows | `0x25f490` returns base+`0x19440`; copier `0x25f4b8` copies512bytes per528byte source row |
| Additional data | start y216,264×6 | `0x25f6b0` returns base+`0x1bd80`; getters report3168bytes |

Derivation: `0x428 = 1064 = 2 * 264 * 2 + 4 * 2`. Therefore the statically evidenced crop is **x4,y2**, not y4. This assumes the capture frame starts at the same raw-layout base; independently check transport alignment. Preserve the complete117,216-byte frame because masks, dummy rows and metadata may be needed for calibration. Some copy methods retain only256words from rows whose reported width is264, another reason to preserve originals.

## Factory table download paths

AY1 `readDownloadBlock` at MicroDM `0x208bf0` constructs a1552-byte `USB_FILE_TRANSFER_INFO` and calls `getFileDownload` at `0x1e7004`, which uses SDK command504 (`0x1f8`). These are SDK enums, not USB bRequest values.

The input struct fields used by this path are dwSize at0, file type at`0x204`, memory-download flag1 at`0x205`, capacity at`0x208`, and output-buffer pointer at`0x210`.

| File type | Proven caller name | Capacity |
|---|---|---|
| 4 | BPM.bin / bad pixel map | 16,384bytes |
| 5 | VC.bin / vignetting correction | sensor-dependent;18,432 or98,304bytes |
| 11 | KMatrix.bin | sensor-dependent;18,432 or98,304bytes |
| 14 | KMatrix2.bin |98,304bytes in sensor-type1/2 branches |

Capacity table at MicroDM `0x8a058` is `[18432,98304,98304]`;98,304 is256×192×2. VC loading has a bundled-resource fallback if camera read fails. A file type's capacity is not its proven actual returned length or element format.

`libHCUSBSDK.so` exports descriptive symbols for this protocol:

1. `CUsbCommandDownload::Excute` (`0x37214c`) checks whether another transfer is busy.
2. `SetDownloadFileType` (`0x37241c`) sends logical selector26/subcommand1 with2-byte payload `{fileType,1}` via internal SDK command503, then queries command3999 state. **SDK503 uses the chunked-write transport, including a length announcement, detailed below.** This selects a download source; it is not a factory-table write. The underlying USB transport still uses SET_CUR for query selection.
3. `GetDownloadFileSize` (`0x372644`, command504 branch `0x372830`) selects selector26/subcommand2. Returned structure is1byte plus4-byte little-endian size; the size is checked against destination capacity.
4. `CUsbDeviceVideoBase::Download` (`0x394c44`) launches `DownloadThreadProcessLocal` (`0x394dfc`). The thread repeatedly requests selector26/subcommand2 in512byte buffers until the announced file size is copied.
5. `ParseRecvData<tagINTER_BIG_DATA_FILE>` (`0x39ed8c`) removes the protocol-dependent prefix, then reads a1-byte field and a4-byte field, and copies the remaining data after that5-byte file header. The meanings of both header fields are not yet verified.

This describes a static read sequence, **not yet a validated calibration downloader**. Before implementation, resolve both outer protocol prefix and file header, status meanings, total length, chunk progression, completion, timeout and cancellation. Reject zero/oversized/short reads and persist original blobs with serial number and hash.

For the detected UVC2 path, the download thread explicitly requests the **unchunked transport** read mode (`0x394fe4` setsw6=0); its repeated reads are file chunks, each with the single5-byte file header removed by `0x39ed8c`. Do not strip a second5-byte transport header. The first size reply is parsed by `0x39f358`: byte0 flag and little-endian uint32 at1. The native implementation uses512-byte read buffers and stops once accumulated file payload reaches the announced size. Windows KS may cache a property's length, so confirm that its sizing behavior follows the firmware's changing GET_LEN between size and data phases.

Receive parser details: `0x39ed9c` copies header byte0, `0x39eda4` copies uint32LE at1, and `0x39edb4` derives payload length as actual returned length minus protocol prefix minus5. Neither the parser nor `DownloadThreadProcessLocal` validates the header values. Their flag/sequence interpretation is therefore not established by this read path. The download thread rejects accumulated length plus new payload greater than announced total (`0x395018`–`0x39501c` -> error28 at`0x39521c`); it does **not** trim final padding. A short final USB result is allowed by the native unchunked reader because actual returned length is forwarded at`0x37a5f8`. Our helper now permits a short final packet containing at least one payload byte, while retaining strict total bounds. Offline `test-factory-parser.ps1` verifies full and short final packets, empty packets, overruns, completed/negative bounds and oversized packets without opening hardware.

Experimental helper: `scripts/protocol/read-factory-tables.ps1`, compiled jointly from `KsCameraControl.cs` and `KsFactoryDownload.cs`. `-CompileOnly` opens no hardware; `-FileTypes 4 -SizeOnly` performs the bounded first-size probe. It permits only source types4/5/11/14, source-selection payload`{type,1}`, and selector5 envelopes`{26,1,1,0}` / `{26,2,1,0}`. A download saves the complete transaction log plus hash-named binary. It intentionally stops on unknown size/framing rather than interpreting padding or retrying guessed commands. Do not run this helper concurrently with capture control or shutter transactions: all logical commands share selector5.

### Source-selection framing correction and live results

The source request is **not** a plain two-byte SET. Its complete static chain is:

1. `SetDownloadFileType` at `0x372490` passes `FillUvcExternalContext(ctx,2,0,1,5000,5000)`. `0x3bd348` stores the third integer argument at context+`0x48`.
2. `DoUvcCommonExcuteImpl` at `0x3724b8` receives package flags0 and a null common condition. `PackageSendData<INTER_DATA_FILETYPE>` at `0x374168` therefore inserts no channel byte in the data body. The converter receives packet+11, and the UVC2 transport removes those11 internal header bytes (`0x379f10`). The selector5 switch still uses default channel1.
3. `CommonDeviceConfig` loads the context+`0x48` flag at `0x373e24`. Because it is1, it first sends the logical-length announcement through an unchunked write at `0x373e60`–`0x373ec4`. `ConvertData<INTER_COMMON_GET_LEN_V20>` at `0x3a47a0` forcibly emits byte1 followed by the little-endian logical length2. Thus the first selector26 SET is exactly `01 02 00 00 00`.
4. `ConvertData<INTER_DATA_FILETYPE>` writes `{type,1}` at `0x3a472c`–`0x3a4734` but reports length8 at `0x3a4738`. The caller's packet is zeroed. The subsequent chunked transport at `0x379f50` builds byte2, sequence uint32LE1, then those8 serialized bytes. The exact first chunk for KMatrix is `02 01 00 00 00 0b 01 00 00 00 00 00 00` (13bytes). This mismatch between logical length2 and serialized length8 is present in the supplied SDK; it is not an invented six-byte calibration field.
5. The chunked path sets transfer length to payload+5 at `0x37a01c`–`0x37a034`. Unlike the unchunked path, its later GetDataLen call does **not** overwrite that transfer length. It queries status after the source transfer, then selects26/subcommand2 for size and data reads. No delay occurs between successful source selection and size retrieval in `CUsbCommandDownload::Excute` (`0x372328`–`0x372338`).

Live probes on2026-11-07 with this corrected sequence for filetypes4 and11 still returned status00, followed by S_OK with **zero returned bytes** for the size GET. The Windows property sizing result remained5; a512-byte read also returned zero. Buffers prefilled withA5 remained unchanged, so no hidden returned bytes were interpreted. Earlier plain `{type,1}` probes omitted the chunked transport and cannot establish a driver limitation. No factory blobs or hashes have been produced.

`research/factory-tables/factory-download-*.json` records requests, HRESULTs, returned lengths and timestamps. The helper tries the topology node's IKsControl first, falling back to the filter interface. All allocated buffers and COM objects are released on failure. An exploratory selector5 GET was removed: it is not an SDK echo request and returned only two bytes; a following status0b from that experiment is not evidence that a correctly framed source request is rejected.

Windows caches XU discovery information and queries GET_LEN during device initialization ([Microsoft device requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/device-requirements-for-usb-video-class-extension-units)). A cached5-byte control size truncating the13-byte source SET is a plausible explanation, **not yet proven**. The built-in ETW diagnostic `scripts/protocol/trace-factory-headers.ps1` requests only USB-UCX HeadersBusTrace events and stops its session in a finally block. Starting the trace returned Access denied because the current process lacks administrator rights; unsandboxed execution did not elevate the Windows token. No trace was started. Do not claim a transport root cause without observing actual setup lengths or other independent evidence. No driver has been replaced or installed.

### Static initialization and firmware identity

`getNucStaticParams` starts at MicroDM `0x201ba4`. Its immediate path obtains an embedded131072-byte fallback resource from `0x27fc74`, tries VC filetype5, then BPM filetype4, calls `getAY1DeviceInfo` at `0x2079a0`, then reads K/K2. The immediate path contains no device authentication, download-enable or factory-mode write. `getAY1DeviceInfo` compares cached model strings and obtains dimensions through a getter; this does not prove that every earlier SDK initialization step is irrelevant.

Read-only SDK2011 device identity (selector1/subcommand1) succeeds with488bytes. This unit reports `APP_010012_BUILD_20260828`, `DSP_2026-08-28_CAMERAID_065356A000`, sensor string `065356A000`, and model/serial `SK0220260901AAWRAL0000541`. The raw identity response is preserved in the transaction reports.

There is also thermometry SDK command2054: its execution at HCUSB `0x2b6040` invokes DoubleGet for selector3/subcommand14. Do not confuse that thermometry blob with NUC filetype14.

The exact UVC2 thermometry DoubleGet flow is selector5 SET `03 0e 01 00`, followed by an **unchunked** five-byte GET of selector3. `ParseRecvData<unsigned int>` at`0x39c490` reads the announced size as little-endian uint32 at offset1; zero and`0xffffffff` are rejected by`0x31b4ac`. The second read at`0x31b578` enables **chunked transport**, so `ProtocolStrategyUvc20::ReadDataStrategy` repeatedly requests `min(remaining,maxRead-5)+5` bytes and removes a five-byte transport header from each packet. The chunked reader checks actual returned length equals expected payload+5 at`0x37a4c0`–`0x37a4cc`; it does not inspect header values. This differs from factory file downloads, which use unchunked transport for each file packet.

After thermometry chunks are reassembled, `ParseRecvData<USB_THERMOMETRY_CALIBRATION_FILE>` at`0x39d67c` treats the body as a64-byte name/header, uint32LE file length at offset64, and file bytes at offset68 (after the protocol object's prefix, which must be confirmed for the chosen backend). The SDK parser checks file length against the announced reassembled length, but a safer implementation must require `68+fileLength <= assembledLength` before copying. SDK2054 does not send the filetype26 source selection.

The helper accepts `-FileTypes 2054` for this separate read-only thermometry query. It caps the complete wire body at4MiB and the loop at25seconds, checks exact chunk lengths, and would save a complete body as `ThermometryWireBody-<hash>.bin` without claiming an extracted calibration file. Live probe `factory-download-20261107-151627-822.json` successfully selected `03 0e 01 00`, reported property size5, then received S_OK/zero bytes from selector3. The following status read timed out with`0x800703e3`. An immediate separate read-only health check returned protocol2.0 and status00 (`research/ks-controls/selectors-4-6.json`); no reset or recovery command was issued. No thermometry body was obtained.

MicroDM test/read wrappers use separate ConfigCommand IDs1057=KMatrix,1058=KMatrix2,1062=shutter template,1063=faulty pixels,1064=background,1065=background table,1066=XS,1067=nonstationary,1068=response rate. They are another API layer, not direct wire commands.

## UVC protocol framing

Static evidence in HCUSBSDK:

- `DetectDeviceVersion` (`0x395f8c`) issues GET_LEN then GET_CUR for selector4 (`wValue=0x0400`) using the extension index from the descriptor. This is a suitable first read-only probe.
- `SwitchCommand` (`0x396320`) uses selector5 (`wValue=0x0500`), SET_CUR bRequest1, bmRequestType`0x21`, with4-byte payload `{targetSelector, logicalSubcommand, channel, reserved}`. Channel defaults1, reserved0. It caches the previous selection to avoid duplicate switches.
- `GetDataLen` (`0x395e3c`) uses GET_LEN bRequest`0x85`, bmRequestType`0xa1`, and a4-byte length buffer in this vendor implementation. Do not assume standard2-byte length behavior without checking the chosen OS path.
- `ProtocolStrategyUvc20::ReadDataStrategy` (`0x37a2fc`) switches command, gets length, and performs GET_CUR (`0x81`). Its chunked mode strips5-byte headers from each result. DoubleGet (`0x31b2ac`) first queries5bytes for protocol2/3 or7bytes for protocol1, then obtains a length-delimited result.
- HCUSB's internal8-byte request header has padding: bmRequest at0,bRequest at1,wValue at4,wIndex at6. Do not serialize that internal layout as a standard USB setup packet.

Windows KS owns the actual UVC transfers and may expose sizing differently from Android libusb. A successful property GET is required before translating the vendor sequence. No generic SET or arbitrary vendor-command UI should be exposed.

## Shutter investigation in progress

The native SDK has both time- and temperature-triggered shutter logic (`IFR_NUC_IDX_TIMESHUTTER_EN`, `IFR_NUC_IDX_TEMPSHUTTER_EN`). It also tracks shutter-down, VB, DDAC, VREF and shutter-up states with timeouts. A fixed30-second app timer has not been established as equivalent to the APK.

AY1 `setShutterControl` begins at MicroDM `0x208394`. Its normal branch calls a virtual method at slot`0x2a0`; the generic internal method at`0x21c598` accepts only modes1..3, copies a cached516-byte image-enhancement structure, replaces byte`0x5c`, then calls the setter at slot`0x298`. Thus a blind toggle or zero-initialized structure would not mirror the SDK.

The setter resolves to `0x21c590` -> `0x1d13c8` -> SDK2081. HCUSBSDK2080(get)/2081(set) both use selector2/subcommand5 (`0x2b2784`/`0x2b2978`). `ConvertData<tagUSB_IMAGE_ENHANCEMENT_EX>` (`0x3a27b4`) emits226bytes; `0x3a28ec` maps native offset`0x5c` to wire offset`0x2f`. Other fields must be preserved from the current device configuration, and outer protocol framing must be validated first.

Mode evidence from worker call sites:

- `0x264640` passes mode2 with literal `ShutterDown` (`0x6bbd5`).
- `0x26523c` passes mode3 with literal `ShutterUp` (`0x69089`).
- Worker helper `0x264738` sends the requested mode, waits100ms, sends mode1 to release control, and waits another100ms when the requested mode was2.

The narrowly scoped hardware workflow is: read and save the selected enhancement payload; verify selector6 status0; send an identical payload with only byte47 changed to2; wait100ms; send byte47=1; wait100ms; process the closed-shutter calibration frames; send byte47=3; wait100ms; send byte47=1; verify status and preserved fields. Both data GET and SET select`02 05 01 00` on selector5. Implement reopening/release on exceptions after a successful down command. An application test cycle that omits host calibration processing is only a shutter actuation test, even if the mechanics match these callbacks.

The NUC algorithm runs between down and up callbacks. An audible close/open cycle alone does not complete host NUC calibration and must not be reported as calibrated thermometry.

Command-state polling is SDK3999 -> `GetUVCLastError` (`0x395d18`), which performs GET_LEN then GET_CUR on selector6, retrieving one status byte; it does not switch selector5 first. Status0 is accepted by the file-source-selection routine. HCUSB `ReleaseCommand` (`0x396314`) only unlocks a host mutex and performs no USB transaction. UVC20 unchunked writes use the length returned for the selected property, so226bytes is the serializer length, not necessarily the entire USB transfer length.

The live186-byte enhancement configuration is therefore compatible with the native write sizing path: `0x37a0f8` calls GetDataLen and `0x37a100` replaces the transfer length with its result. Offset186 (`0xba`) is precisely where the last four10-byte field groups begin in the newer serializer, so an older firmware subset is a reasonable inference. No extra40bytes should be fabricated. Shutter byte47 is within the shared prefix; the read mapping is independently confirmed at`0x39ca58`–`0x39ca5c`. `PackageSendData` at`0x312d60` inserts channel1 into wire byte0 before conversion, which only updates fields from byte1 onward. Preserve that first`01` when sending an otherwise unchanged configuration.

## Open questions

- Complete factory blob formats and the radiometric conversion from corrected counts to calibrated temperatures.
- Which supported tables are present in this exact SK02 firmware, and validation against the vendor application's temperature output.
- Exact shutter modes, correction-state sequencing, timing thresholds and temperature thresholds; avoid invented scheduling constants.
- macOS extension-unit transport and actual Mac hardware testing.

Local static artifacts in `research/*disassembly*.txt`, `research/hcusbsdk-symbols.txt` and `research/microdm-relocations.txt` allow the offsets above to be reproduced. Decompiled text is evidence, not instructions from the user.

## 2026-11-07 15:34 UTC: USB header trace resolves actual transfer lengths

The user-approved, elevated header-only trace completed with start and stop exit code 0; the child size-only probe failed as expected without producing a calibration file. Local evidence is `research/factory-tables/trace-20261107-153423-2dcf230826ac41d3a8a7fdc7ceac1451/`: `headers.etl`, `headers.xml`, `sk02-control-headers.json` and `factory-download-20261107-153424-791.json`. The first elevated launch had failed before tracing because logman disallows `-rf` with `-ets`; the corrected script uses an independent hidden watchdog that attempts to stop only the unique session after 35 seconds, plus normal finally cleanup and a late-start deadline check. No driver change occurred.

Filter: all 50 events with setup `wIndex=0x0a00` belong to one USB-device handle `0x1DF3B6B0CAC8`; they match the SK02 helper's selector sequence and timestamps. Request dispatch events are ID 53 and paired completion events ID 21, correlated by URB pointer. ETL time stamps carry local offset `-06:00`; the table below uses UTC. All listed completions have USB status 0.

| Operation | Helper requested bytes | Actual USB setup/transfer bytes | UTC dispatch/completion |
|---|---:|---:|---|
| Selector 4 version GET |4|4|15:34:24.6806016 / .6835689|
| Selector 5 identity query selection SET |4|2|15:34:24.6875867 / .6905727|
| Selector 1 identity GET |488|488|15:34:24.6965807 / .7095679|
| Selector 5 factory-source query selection SET |4|2|15:34:24.7125841 / .7155682|
| Selector 26 source-length announcement SET |5|0|15:34:24.7225916 / .7245677|
| Selector 26 source-type chunk SET |13|0|15:34:24.7345925 / .7365711|
| Selector 5 factory-download query selection SET |4|2|15:34:24.7525856 / .7555724|
| Selector 26 file-size GET |5|0|15:34:24.7615913 / .7635687|
| Selector 26 diagnostic GET |512|512|15:34:24.7726122 / .7835743|

**This trace disproves the earlier simple cached-GET_LEN hypothesis:** the Windows USB video path issues a fresh UVC GET_LEN (`bmRequestType=0xa1`, `bRequest=0x85`, requested length 2) immediately before every corresponding transfer, including both source SETs. The inspected APK uses a 4-byte GET_LEN request instead. The trace records headers only, so it does not reveal the actual GET_LEN response values or payload contents. Consequently, it does not establish whether the mismatch arises from firmware behavior for 2-byte GET_LEN, Windows property translation, or another protocol-state interaction. It does establish that the intended 5-byte and 13-byte source payloads did not travel in those USB transfers. A successful KS HRESULT/status 00 is insufficient evidence that those payloads reached the camera.

The helper was checked again: `KsFactoryDownload.WriteExact` allocates/copies the full value and passes `value.Length` directly as the COM `IKsControl.KsProperty` data length. Its GET path likewise passes the caller's requested length and records the actual returned count. No local helper truncation or padding explains the observed bus lengths. This is a source review, not proof of every Windows internal translation step.

Resolve the apparent 512-byte discrepancy explicitly: earlier probes returned 0 for their 512-byte diagnostic requests, but **this trace's** diagnostic returned 512 bytes to the application, matching the bus completion. The saved application bytes are `02 01 00 00 00` followed by 507 zeros. The preceding 5-byte size GET returned 0 and left its five sentinel bytes unchanged. The diagnostic packet is therefore an untrusted packet after a failed length phase; it is **not** a valid downloaded K matrix, contains no established announced file size and must not be imported as calibration. No factory table hash or calibrated-temperature result has been obtained.

The Android fallback under `tools/android-calibration-export/` can reproduce the APK's direct USB transfer sizes, including 4-byte GET_LEN, without the Windows property translation. It is locally built/tested against a scripted transport but not yet tested on Android hardware. This provides a concrete next comparison; it does not prove the Windows failure's complete cause.
### Android selector-5 sizing correction

`SwitchCommand` prepares a four-byte command envelope, but its actual wire length comes from `GetDataLen`: call at0x396458, save returned length into w24 at0x39645c, store that length into the transport context at0x3964a8, then issue the write at0x3964c4. Thus the Android helper now queries fresh GET_LEN and sends only the reported2-byte or4-byte allowlisted prefix. It rejects any other selection length. This is distinct from the factory source chunk, whose13-byte length is fixed by the native chunked writer despite its GET_LEN query. Scripted exports test both selector-5 lengths and reject length3.

The first authorized Kindle run reached USB identity/Camera permission successfully but failed the normal `claimInterface(false)`. The helper now makes one `claimInterface(true)` fallback on the verified VideoControl interface0, with cancellation checks before both attempts, release only after successful ownership and connection close in cleanup. The Android API defines `force=true` as disconnecting a kernel driver if necessary; it does not install/replace a driver. Initial claim failure alone does not prove which owner held the interface. See [Android UsbDeviceConnection API](https://developer.android.com/reference/android/hardware/usb/UsbDeviceConnection#claimInterface(android.hardware.usb.UsbInterface,%20boolean)).

## Successful direct Android export: 2026-11-07 15:43:47 UTC

The authorized Kindle session exported the actual camera's factory data using direct Android control transfers. The verified serial is `A43EB0_EXAMPLE`; original ZIP and extracted data are under `research/sk02-device-export-20261107/`. The strict export validator passed identity, seven-file integrity and thermometry wire-body extraction consistency. This validates retrieval, not yet calibrated temperature accuracy.

| File | Bytes | SHA256 |
|---|---:|---|
| BPM.bin |8|6db2f2a22354e32eb2f0cf91ca02995ccd63c3e00c9c07022a6872197d66bbe0|
| KMatrix.bin |98304|9c9e91129efe685858e77709917c36b27b2027b0bcc3ca3e4e18dccb30b704e1|
| KMatrix2.bin |98304|ba0b216b40f588052bfdf4c832d4d37b5ab30cda034fe8451c54fc73064cae51|
| thermometry-calibration.bin |14336|e256ba8addb9f0f914b58123f2cccb7f5a5fc7570884806eefd66ee21144f462|

The retained transaction log shows GET_LEN requested 4 bytes but returning 2 bytes. Selector 5 returns `0200`; the helper sends exactly the two-byte command selection. Selector 26 returns `0500` before the five-byte source-length announcement; after that SET it returns `0700`, while the native-compatible writer still sends the complete 13-byte source packet. The seven meaningful bytes are the five-byte chunk header and the two declared source bytes; the native serialization includes six additional reserved zero bytes. After download selection, GET_LEN returns 5 for the size packet, then 512 for full chunks and the exact remaining length plus five for final chunks. K matrix final packets are 458 bytes; the BPM packet is 13 bytes. Thermometry wire body is 14404 bytes, containing the 14336-byte file at offset68; final transport packet is 213 bytes.

### Windows direct-length comparison prepared

`read-factory-tables.ps1 -DirectLengths` skips the helper's preliminary zero-buffer KS sizing calls. The prior Windows trace proves each of those calls sends an additional GET_LEN; the subsequent actual KS GET/SET also sends GET_LEN. The successful Android transcript contains only one GET_LEN before each transfer. A firmware phase effect from duplicate GET_LEN requests is now a testable hypothesis, not yet a proven cause.

The direct mode uses known firmware identity length488, initial file/thermometry size length5 and bounded data packets `min(512, remaining+5)`. Exact returned lengths are required; on mismatch it stops without consuming an additional diagnostic packet. Source SETs remain the inspected five-byte announcement and 13-byte native packet. Windows may reduce the latter to seven bytes according to the reported length; if so, those seven bytes include the full declared source payload. Only matching downloaded bytes and SHA256 against this Android export will establish successful desktop retrieval. The old probing mode and all prior evidence remain available unchanged.

## Windows direct retrieval verified: 2026-11-07 15:47 UTC

The desktop read succeeded after removing preliminary zero-buffer KS sizing queries. A BPM size-only probe announced8 bytes, followed by a full `-DirectLengths -FileTypes 4,11,14,2054` download in approximately7 seconds. Evidence is `research/factory-tables/direct-lengths/factory-download-20261107-154738-430.json`. All four downloaded files have exactly the same byte lengths and SHA256 as the independent Android export, including the complete thermometry wire body hash `818e04c14a99b892731ddbcd4325c1b49256c62fe598f2c15514cf1cceddad21`.

Thus a working Windows path uses the existing USB video driver and ordinary IKsControl. No driver replacement, libusb filter or administrator access is needed for retrieval. The isolated fix is omitting extra helper-generated GET_LEN queries; the driver still performs its own fresh GET_LEN before each actual request. This strongly supports a state interaction caused by redundant sizing calls, but no firmware source or payload trace proves the exact internal state transition. The earlier cached-length explanation is superseded.

### Compiled desktop exporter

Build with `node scripts/build-controls.cjs`. The helper command is:

```
Caloraview.CameraControl.exe download-calibration <exact-camera-moniker> <empty-output-directory>
```

It resolves the selected interface's actual USB serial through its PnP parent, repeats that identity check after downloading, retains raw transaction evidence, writes the seven standard export files and writes `manifest.json` only after all files pass local integrity/length checks. The manifest uses provenance method `Windows IKsControl` and the same export format as Android. JSON stage messages report progress; the final result includes serial, directory, manifestPath and `radiometryValidated:false`. It never enables temperature conversion itself. The desktop runtime must validate/cache the bundle against this returned serial before subsequent research use. `scripts/protocol/test-calibration-export.ps1` tests physical-serial parsing and exact-moniker selection, including rejecting generated/interface instances as serials, without opening hardware.

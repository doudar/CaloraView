# Research calibration export validation

> Historical investigation note: referenced APKs, extracted libraries, device exports, captures, and generated reports are not distributed. Paths below describe the original investigation environment. Device serials have been replaced with examples. See [repository scope](../README.md#repository-contents).

The Android helper and Node validator share `accuheat-calibration-export-v1`.

This legacy format identifier is intentionally retained after the Caloraview rebrand so existing device exports remain readable.

The validator checks an extracted local directory. The same core validation is

used before Caloraview caches or loads factory data; validation alone does not

read a camera or calculate temperatures.

```powershell

node scripts/research/validate-calibration-export.cjs 'research/my-export' --expected-serial 'EXACT-CAMERA-SERIAL'

node --test test/calibration-export.test.cjs

```

Choose the expected serial independently from the physical camera or a previously

verified capture. Copying an arbitrary export's claimed serial into the command

does not establish which camera produced it. The validator compares exact serials;

it does not trim or change case. Missing or placeholder serials are rejected.

The JSON report has `valid`, `complete`, `researchOnly`, per-file checks and errors.

Exit status is 0 for an accepted complete bundle, 1 for failed validation, and 2

for invalid command syntax. `radiometryValidated` is always false. Incomplete

bundles remain useful for research, but return `valid: false`; available files

are still checked.

## Manifest contract

Required top-level fields are:

- `format`: `accuheat-calibration-export-v1`.

- `createdUtc`: an ISO UTC timestamp ending in `Z`.

- `protocolVersion`: `2.0`, emitted by the exporter after its version query succeeds.

- `device`: `{vendorId: 14526, productId: 388, model: "SK02", serial: "..."}`.

- `provenance.method`: `Android UsbDeviceConnection.controlTransfer` or `Windows IKsControl`.

- `complete`: a boolean, true only for a completed bundle.

- `files`: entries containing `name`, integer `bytes`, and SHA-256 hex `sha256`.

The exporter also records `outcomes` and `provenance.sourceApk` for diagnosis.

The manifest does not hash itself. The validator reports its independently

calculated SHA-256 for tracking revisions.

| Exact filename | Recovered operation/type | Accepted byte bounds |

| --- | --- | --- |

| `BPM.bin` | Factory type 4 | 1–16,384 |

| `KMatrix.bin` | Factory type 11 | 1–98,304 |

| `KMatrix2.bin` | Factory type 14 | 1–98,304 |

| `thermometry-wire-body.bin` | Selector 3 / subcommand 14, transport headers removed | 69–4,194,304 |

| `thermometry-calibration.bin` | Extracted thermometry file | 1–4,194,236 |

| `device-identity.bin` | Selector 1 / subcommand 1 | 1–512 |

| `transactions.tsv` | Local transaction evidence | 1–16,777,216 |

The original seven files remain required for legacy export acceptance. Current

Windows exports also attempt VC, recording the outcome. This unit supplies an

eighth file, exactly 98,304 bytes; live factory processing requires that actual

map. Older caches are refreshed once for VC support. Bounds mirror the exporter and limit file

reads; they are not proof of a valid device-specific table structure. The

thermometry body's uint32 length at offset 64 must match its remaining length,

and bytes from offset 68 must exactly equal `thermometry-calibration.bin`.

This verifies consistency of the extraction assumption, not its correctness for

every firmware.

Unknown names, paths, alternate data stream syntax, duplicate entries, mismatched

sizes/hashes, symbolic links, junctions and non-regular files are rejected. The

manifest is limited to 128 KiB. Files must resolve directly inside the selected

directory; linked export roots are rejected. Files are checked before and after

reading to detect ordinary concurrent replacement or modification. Do not treat

this local validator as an adversarial filesystem sandbox.

SHA-256 detects differences relative to the manifest, but a manifest and its

hashes can be rewritten together. Neither hashes nor the identity string

authenticate an export. Factory-content parsing, checksums, calibration model

compatibility, complete NUC processing and accuracy against reference targets

remain separate work before live Celsius output is appropriate.

The synthetic tests include traversal, identity mismatch, corrupt sizes/hashes,

wire/file inconsistency and malformed manifests. Real symlink creation can be

blocked by the host policy; that integration case skips explicitly when creation

is denied, while a separate mocked filesystem test verifies link rejection.

No vendor images, factory tables or real USB commands are embedded in the tests.

## Native-reference preflight for a real export

After an actual camera export becomes available:

1. Preserve the original ZIP and extract it into a new research directory. Run

   the validator with the independently recorded serial. Preserve its JSON

   report alongside, rather than modifying, the original manifest.

2. Inspect the extracted calibration's uint32 version at offset 0, uint32

   declared size at 4, uint32 model discriminator at 8, bounded model string

   starting at 0x10, and signed32 scaling/type fields at 0x2b10/0x2b14. These are

   recovered fields, not a complete content-validation scheme. Record the file

   hash and compare the model identity with the selected camera; a different

   sample's model string is not a compatibility guarantee.

3. The current ARM64 oracle accepts exactly 0x3800 bytes with a matching declared

   size. Other sizes require protocol/library investigation before execution.

   Native initialization and configuration statuses must all succeed. The runner

   records its library, script, inputs and output hashes plus dependency versions.

4. Measurement calls additionally require verified compact metadata from this

   device and correctly processed detector counts from the same state. Current

   raw USB extra rows are not automatically equivalent to the compact metadata

   expected by MTlib. Complete factory NUC must precede radiometry. A preview

   flat field alone does not establish these prerequisites.

5. Once those inputs are verified, use explicitly recorded ambient/reflected

   temperatures, humidity, distance and emissivity. Check overall and per-point

   statuses. MTlib results are Q6; the public MicroTA Q13 representation is a

   separate boundary. Compare against reference targets before any live Celsius

   integration.

Do not combine a real calibration export with bundled JPEG metadata, substitute

sample calibration when a download fails, or infer temperature accuracy from

successful initialization. See [radiometry-investigation.md](radiometry-investigation.md)

for the existing oracle command and the distinction between the offline sample

experiment and the live camera pipeline.

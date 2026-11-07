# Third-party display models and runtime

These components enhance display images only. They do not replace camera calibration, increase independent temperature measurements, or alter saved detector frames. The model training domains are general natural images; generated detail is not validated thermal ground truth.

## Real-ESRGAN DN50 grayscale x2

Upstream: [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN), Copyright (c) 2021 Xintao Wang, BSD-3-Clause. The complete license is retained in `Real-ESRGAN-LICENSE.txt`.

The model derives from the official v0.2.5.0 `realesr-general-x4v3.pth` and `realesr-general-wdn-x4v3.pth` release weights, interpolated equally (DN50). The wrapper repeats normalized grayscale to three channels, applies the SRVGG network, averages output RGB, clamps to 0..1, and average-pools 2 × 2 to produce 512 × 384. These are Caloraview conversion/wrapper modifications; no retraining was performed. `real-provenance.json` preserves source URLs, both upstream hashes, derived hash, model interface and export-script reference.

## FSRCNN x2 CPU fallback

Upstream: [Saafke/FSRCNN_Tensorflow](https://github.com/Saafke/FSRCNN_Tensorflow), commit `6a4812c4ef1c4f5947d79beafa32a05a6eb4a94d`, Apache-2.0. The complete license is retained in `FSRCNN-LICENSE.txt`.

Upstream describes a subpixel variant trained on T91 and finetuned on General100. The conversion copies frozen float32 weights, changes kernel layout from HWIO to OIHW, fixes NCHW input/output dimensions, and algebraically folds PReLU. It does not retrain the network. `fsrcnn-attribution.json` preserves the upstream revision, original and derived SHA256 values, license hash and modification summary. Independent original-PB/ONNX comparisons bound numerical differences; they are not a physical image-accuracy claim.

## ONNX Runtime

`onnxruntime-node` 1.31.1 declares MIT licensing. The upstream Microsoft license is retained as `ONNXRuntime-LICENSE.txt`, retrieved from [the official repository](https://github.com/microsoft/onnxruntime/blob/main/LICENSE). Its package and native dependencies have their own distribution notices; this file does not replace those. See the [upstream third-party notices](https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt).

These notices record the source licensing and modifications; they do not claim legal clearance, ownership of upstream work, or equivalence to the proprietary Android/iOS enhancement. Vendor APK model assets and user camera imagery are not included here.

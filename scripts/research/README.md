# Historical analysis source

These are original Caloraview scripts retained alongside the protocol findings in `docs/`. No decompiled vendor source, native libraries, model assets, device calibration, captured frames, or generated oracle outputs are included.

Scripts that reference `research/` or `test-output/` require separately supplied inputs at those locations. They are historical analysis tools, not part of `npm ci`, `npm test`, packaging, or desktop startup. Optional Python/emulator environments are likewise not shipped.

The Real-ESRGAN and FSRCNN conversion scripts describe the independently sourced open display models in `src/models/`. Their source URLs, hashes, transformations, and licenses are recorded there. Repeating historical image benchmarks requires your own input frames.

`validate-calibration-export.cjs` is a standalone validator and uses only the portable source module; it needs no vendor library or Python environment.

# Contributing

Use Node.js 22 or newer. Run `npm ci`, `npm run check:repo`, and `npm test` before opening a pull request. Build on the target operating system with `npm run dist:win` or `npm run dist:mac`.

Keep raw detector data and temperature calculations independent from display enhancement. Tests should use synthetic fixtures and avoid real camera access. Hardware and UI scripts are separate from CI; describe any manual validation in the pull request.

Do not commit APKs, extracted vendor assets, camera calibration exports, recordings, credentials, or generated build output. The repository guard checks staged files even if they match `.gitignore`. Open model additions need source attribution, redistribution notices, and hashes.

Historical investigation notes and original scripts are retained for implementation context. Their private inputs and generated outputs are not distributed. The normal app build and unit tests need none of those inputs. See [development notes](docs/DEVELOPMENT.md) and [release operations](docs/RELEASING.md).

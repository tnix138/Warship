# Build compatibility — `uWebSockets.js` × GLIBC

The server depends on [`uWebSockets.js`](https://github.com/uNetworking/uWebSockets.js), which
ships **prebuilt native binaries** rather than compiling from source. Each release is linked
against the GLIBC that was current in its build container, so the newest release is not
necessarily the one that runs on your host. A mismatch fails at `require` time with
`GLIBC_2.xx not found`, not at install time.

This page records what we measured, so the next person does not have to rediscover it.

## Verified matrix

Measured on **Debian 12 (bookworm), `GLIBC 2.36`, Node.js 22.22.3, x86-64**.

| uWS version  | Loads on GLIBC 2.36 | Notes                                                         |
| ------------ | ------------------- | ------------------------------------------------------------- |
| `v20.52.0`   | ✅ yes              | **Pinned.** Newest release that loads here.                   |
| `v20.53.0`   | ❌ no               | `GLIBC_2.38 not found` — binary needs a newer runtime.        |
| ≥ `v20.53.0` | ❌ no (expected)    | Requires GLIBC 2.38+, i.e. Ubuntu 24.04 / Debian 13 or newer. |

`packages/server/package.json` pins the exact tarball:

```json
"uWebSockets.js": "https://codeload.github.com/uNetworking/uWebSockets.js/tar.gz/refs/tags/v20.52.0"
```

A version range is deliberately avoided: uWS publishes no npm semver range that maps to
"the newest binary my libc can load", so an explicit tag is the only reproducible pin.

## Checking your own host

```bash
# What your libc provides:
ldd --version | head -1

# Whether the pinned build loads (this is the real compatibility test):
node -e "require('uWebSockets.js')" && echo "uWS OK"

# Which GLIBC symbols a specific binary demands:
objdump -T node_modules/uWebSockets.js/uws_linux_x64_*.node | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -3
```

If `require` throws `GLIBC_2.38 not found`, your libc is older than the binary. Either run on
a newer base image, or lower the uWS tag until it loads and record the result in the table above.

## Choosing a tag for a new environment

1. Start from the newest tag and try `node -e "require('uWebSockets.js')"`.
2. If it fails with `GLIBC_x.yy not found`, step back one minor release and retry.
3. Once a tag loads, run `pnpm --filter @warship/server run test` — a library that loads but
   misbehaves is worse than one that fails loudly.
4. Add the result to the table above.

## Notes on the environment this repository was built in

- The sandbox that produced Milestone 1 and 2 runs Debian 12 / GLIBC 2.36, which is why the
  pin sits at `v20.52.0`.
- Fetching the tarball from `codeload.github.com` over TLS needed
  `NODE_OPTIONS=--use-system-ca`; see the install command in the root `README.md`.
- `import 'uWebSockets.js'` does not work as a bare ESM import (the package is CommonJS with a
  native addon). `packages/server/src/net/uws.ts` loads it through `createRequire` and exposes
  typed re-exports instead.

## Deployment targets we intend to support

| Target               | GLIBC | uWS tag that works                             |
| -------------------- | ----- | ---------------------------------------------- |
| Debian 12 (bookworm) | 2.36  | `v20.52.0`                                     |
| Debian 13 (trixie)   | 2.41  | newest (≥ `v20.53.0`)                          |
| Ubuntu 22.04 LTS     | 2.35  | `v20.52.0` or older — **not yet verified**     |
| Ubuntu 24.04 LTS     | 2.39  | newest (≥ `v20.53.0`) — **not yet verified**   |
| Alpine (musl)        | n/a   | **unsupported** — uWS prebuilds are glibc-only |

Relying on `node:alpine` images will not work without compiling uWS from source; the
container base should be Debian- or Ubuntu-based.

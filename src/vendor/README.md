# Vendored libraries

Embedded verbatim into the single-file build (no runtime CDN — DESIGN §4.3).

| File | Library | Version | Source | sha256 |
|---|---|---|---|---|
| `nacl.min.js` | TweetNaCl | 1.0.3 | npm `tweetnacl@1.0.3` (via jsDelivr) | `973cc5733cc7432e30ee4682098f413094f494bccf76a567c23908c5035ddbbc` |
| `gun.min.js` | Gun (browser build) | 0.2020.1240 | npm `gun@0.2020.1240` (via jsDelivr) | `bf46188671f968792a1e2789e3cf1cd8632117845700e9f0c7f57bdc897efa25` |
| `qrcode.js` | qrcode-generator (min) | 1.4.4 | npm `qrcode-generator@1.4.4` (jsDelivr min) | `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780` |
| `jsQR.js` | jsQR (min) | 1.4.0 | npm `jsqr@1.4.0` (jsDelivr min) | `6f139698c4ccab1764764600cc6d1baf12fa00f00ee4b8781e36ed337e0fda07` |

To re-verify: `shasum -a 256 src/vendor/*.min.js`.

Notes:
- The browser `gun.min.js` bundles gun's storage adapter (localStorage); the bare `gun/gun.js`
  core does not and won't retain/serve data on its own.
- Node tests use the npm `gun` package (full build) — see `test/phase3.test.cjs`.

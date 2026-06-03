/* Xnet — QR encode (qrcode-generator) and decode (jsQR over a photo/uploaded image).
   No live camera (DESIGN §2.2): decoding takes an ImageData from a <canvas> of an uploaded
   or photographed picture. */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};
  var qrcode = root.qrcode;          // qrcode-generator global
  var jsQR = root.jsQR;              // jsQR global

  // Build a QR model from text. ecc 'L' maximizes capacity (invites are sizeable); the screen
  // shows it big and the scan is a still photo, so error correction can be low.
  function model(text, ecc) {
    var qr = qrcode(0, ecc || 'L');  // type 0 = auto-pick the smallest version that fits
    qr.addData(text);
    qr.make();
    return qr;
  }

  // Returns a GIF data: URL suitable for <img src>. cell = px per module, margin = quiet-zone modules.
  function toDataURL(text, opts) {
    opts = opts || {};
    return model(text, opts.ecc).createDataURL(opts.cell || 5, opts.margin || 4);
  }

  // Rasterize a QR model to RGBA ImageData-like bytes (used by tests; the browser uses an <img>).
  function rasterize(text, opts) {
    opts = opts || {};
    var cell = opts.cell || 4, margin = opts.margin || 4;
    var qr = model(text, opts.ecc), n = qr.getModuleCount();
    var size = (n + margin * 2) * cell;
    var data = new Uint8ClampedArray(size * size * 4);
    for (var i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = 255; }
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      var x0 = (c + margin) * cell, y0 = (r + margin) * cell;
      for (var dy = 0; dy < cell; dy++) for (var dx = 0; dx < cell; dx++) {
        var p = ((y0 + dy) * size + (x0 + dx)) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
      }
    }
    return { data: data, width: size, height: size };
  }

  // Decode an ImageData ({data, width, height}) -> text or null.
  function decode(imageData) {
    var fn = root.jsQR || jsQR;
    if (!fn) return null;
    var res = fn(imageData.data, imageData.width, imageData.height);
    return res ? res.data : null;
  }

  Xnet.qr = { toDataURL: toDataURL, rasterize: rasterize, decode: decode, model: model };
})(typeof window !== 'undefined' ? window : globalThis);

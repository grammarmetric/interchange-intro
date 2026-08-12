/**
 * pngcrop.mjs - minimal, dependency-free PNG reader / cropper / writer.
 *
 * Exists because this pipeline must run on a machine with no ImageMagick and
 * no ffmpeg. Node's zlib is the only thing it needs.
 *
 * Supports 8-bit non-interlaced PNG, colour types 0 (grey), 2 (RGB),
 * 4 (grey+alpha) and 6 (RGBA) - which covers everything `pdftoppm -png`
 * emits. Anything else throws loudly rather than producing a wrong crop.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function crc32(buf) {
  let c;
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a PNG file into { width, height, channels, data } (raw samples). */
export function readPNG(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error(file + ': not a PNG');

  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12]
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!ihdr) throw new Error(file + ': no IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(file + ': bit depth ' + ihdr.bitDepth + ' unsupported (need 8)');
  if (ihdr.interlace !== 0) throw new Error(file + ': interlaced PNG unsupported');
  const channels = CHANNELS[ihdr.colorType];
  if (!channels) throw new Error(file + ': colour type ' + ihdr.colorType + ' unsupported');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  let ri = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ri++];
    const line = raw.subarray(ri, ri + stride);
    ri += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(file + ': bad filter ' + filter + ' on row ' + y);
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, colorType: ihdr.colorType, data: out };
}

/** Return a new image containing the rectangle, clamped to the source bounds. */
export function cropImage(img, x, y, w, h) {
  const x0 = Math.max(0, Math.min(img.width, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.height, Math.round(y)));
  const x1 = Math.max(x0, Math.min(img.width, Math.round(x + w)));
  const y1 = Math.max(y0, Math.min(img.height, Math.round(y + h)));
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw === 0 || ch === 0) throw new Error('crop is empty: ' + [x, y, w, h].join(','));
  const ch3 = img.channels;
  const out = Buffer.alloc(cw * ch * ch3);
  for (let row = 0; row < ch; row++) {
    const src = ((y0 + row) * img.width + x0) * ch3;
    img.data.copy(out, row * cw * ch3, src, src + cw * ch3);
  }
  return { width: cw, height: ch, channels: ch3, colorType: img.colorType, data: out };
}

/**
 * Box-downscale by an integer-ish factor. Book scans render at 140 dpi, which
 * is more pixels than a phone will ever show; halving keeps the repo small.
 */
export function scaleImage(img, maxWidth) {
  if (img.width <= maxWidth) return img;
  const f = img.width / maxWidth;
  const w = Math.max(1, Math.round(img.width / f));
  const h = Math.max(1, Math.round(img.height / f));
  const c = img.channels;
  const out = Buffer.alloc(w * h * c);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * img.height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * img.width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
      for (let ch = 0; ch < c; ch++) {
        let sum = 0;
        let n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            sum += img.data[(sy * img.width + sx) * c + ch];
            n++;
          }
        }
        out[(y * w + x) * c + ch] = Math.round(sum / n);
      }
    }
  }
  return { width: w, height: h, channels: c, colorType: img.colorType, data: out };
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** Encode with per-row adaptive filtering (the standard minimum-sum heuristic). */
export function writePNG(file, img) {
  const { width, height, channels, data } = img;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];

  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? cur[x - channels] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= channels ? prev[x - channels] : 0;
        let v;
        if (f === 0) v = cur[x];
        else if (f === 1) v = cur[x] - a;
        else if (f === 2) v = cur[x] - b;
        else if (f === 3) v = cur[x] - ((a + b) >> 1);
        else v = cur[x] - paeth(a, b, c);
        v &= 0xff;
        cand[f][x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = img.colorType;
  const png = Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}

/**
 * Minimal pure-JS PNG decoder (8-bit RGB/RGBA, non-interlaced).
 *
 * Why: browsers on wide-gamut displays (e.g. macOS P3) apply color management
 * during ImageBitmap/canvas decode, which can perturb elevation-encoded RGB
 * by ±1 per channel — and ±1 on the terrarium R channel is ±256 m of
 * elevation, i.e. random giant spikes (see deck.gl issue #10400).
 * Decoding the PNG bytes ourselves bypasses that pipeline entirely.
 */
export async function decodePNG(bytes) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new Error('not a PNG');
  }

  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= bytes.length) {
    const len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`unsupported color type ${colorType} (need RGB/RGBA)`);
  }
  const bpp = colorType === 2 ? 3 : 4;

  // zlib-inflate the IDAT stream (browser-native, no color management possible)
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());

  // unfilter scanlines
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('PNG data truncated');
  const out = new Uint8Array(width * height * bpp);
  let prev = null;
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = i >= bpp && prev ? prev[i - bpp] : 0;
      let v = raw[p + i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      cur[i] = v & 0xff;
    }
    p += stride;
    prev = cur;
  }
  return { width, height, bpp, data: out };
}

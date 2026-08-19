/**
 * Master Color — motor de casamento de cor
 * Alex Ascencio · Adobe Premiere Pro
 *
 * A diferença para a versão antiga:
 *
 *   ANTES  o plugin media só a referência e escrevia a correção que
 *          NEUTRALIZAVA aquela imagem. Referência quente gerava grade fria.
 *          Servia como balanço de branco, não como "pegar o look".
 *
 *   AGORA  ele mede o CLIPE e a REFERÊNCIA e calcula a diferença entre os
 *          dois. O Lumetri recebe o caminho que leva o clipe até a
 *          referência. Referência quente deixa o clipe quente.
 *
 * Pipeline:
 *   1. amostragem uniforme (até 4000 px) das duas imagens
 *   2. sRGB linear -> XYZ (D65) -> LAB
 *   3. estatísticas por zona tonal (sombras / meios / altas) em L*, a*, b*
 *   4. percentis de luminância (p05 / p50 / p95) = ponto de preto, meio, branco
 *   5. delta referência-clipe -> controles do Lumetri
 *   6. força (0..100%), proteção de pele e trava anti-clipping
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MasterColor = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ═══════════════ limites do Lumetri ═══════════════ */
  var LIM = {
    exposure:    { min: -3.5, max: 3.5 },
    contrast:    { min: -60,  max: 60  },
    highlights:  { min: -90,  max: 60  },
    shadows:     { min: -70,  max: 80  },
    whites:      { min: -60,  max: 60  },
    blacks:      { min: -60,  max: 60  },
    temperature: { min: -60,  max: 60  },
    tint:        { min: -40,  max: 40  },
    saturation:  { min: 40,   max: 180 },
    vibrance:    { min: -50,  max: 60  }
  };
  var D65 = { x: 0.95047, y: 1.0, z: 1.08883 };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lim(v, k) { return clamp(v, LIM[k].min, LIM[k].max); }

  /* ═══════════════ conversões ═══════════════ */
  function linearize(v) {
    var n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  }
  function rgbToXyz(r, g, b) {
    var R = linearize(r), G = linearize(g), B = linearize(b);
    return {
      x: R * 0.4124564 + G * 0.3575761 + B * 0.1804375,
      y: R * 0.2126729 + G * 0.7151522 + B * 0.0721750,
      z: R * 0.0193339 + G * 0.1191920 + B * 0.9503041
    };
  }
  function xyzToLab(c) {
    function f(t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116; }
    var fx = f(c.x / D65.x), fy = f(c.y / D65.y), fz = f(c.z / D65.z);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }
  function rgbToLab(r, g, b) { return xyzToLab(rgbToXyz(r, g, b)); }

  /** Saturação HSL, só o canal S. */
  function satOf(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return 0;
    var d = mx - mn;
    return l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  }

  /** Matiz em graus (0-360). Usado só para achar pele. */
  function hueOf(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    var h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  /** Pele: matiz laranja-avermelhado, saturação média, não muito escuro. */
  function isSkin(r, g, b) {
    var h = hueOf(r, g, b), s = satOf(r, g, b);
    var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return h >= 5 && h <= 50 && s >= 0.12 && s <= 0.72 && lum > 40 && lum < 235 && r > g && g > b;
  }

  /* ═══════════════ análise ═══════════════ */

  /**
   * Mede uma imagem e devolve o perfil estatístico.
   * @param {ImageData} img
   * @returns {Object} perfil
   */
  function analyze(img) {
    var px = img.data, total = px.length / 4;
    var step = Math.max(1, Math.floor(total / 4000)) * 4;

    var zones = {
      sh: { L: 0, a: 0, b: 0, n: 0 },
      mid: { L: 0, a: 0, b: 0, n: 0 },
      hi: { L: 0, a: 0, b: 0, n: 0 }
    };
    var sumL = 0, sumA = 0, sumB = 0, sumS = 0, n = 0;
    var skin = 0, lowSatSum = 0, lowSatN = 0;
    var clipHi = 0, clipLo = 0;
    var hist = new Uint32Array(256);

    for (var i = 0; i < px.length; i += step) {
      var r = px[i], g = px[i + 1], bl = px[i + 2];
      var lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      hist[Math.min(255, Math.max(0, Math.round(lum)))]++;

      var lab = rgbToLab(r, g, bl);
      var z;
      if (lab.L < 30) { z = zones.sh; if (lab.L < 2) clipLo++; }
      else if (lab.L < 75) { z = zones.mid; }
      else { z = zones.hi; if (lab.L > 98) clipHi++; }
      z.L += lab.L; z.a += lab.a; z.b += lab.b; z.n++;

      sumL += lab.L; sumA += lab.a; sumB += lab.b;
      var s = satOf(r, g, bl);
      sumS += s;
      if (s < 0.35) { lowSatSum += s; lowSatN++; }
      if (isSkin(r, g, bl)) skin++;
      n++;
    }

    if (!n) n = 1;
    function zavg(z) {
      return z.n ? { L: z.L / z.n, a: z.a / z.n, b: z.b / z.n, n: z.n }
                 : { L: sumL / n, a: sumA / n, b: sumB / n, n: 0 };
    }

    // percentis de luminância
    var cum = 0, prev = 0, p05 = 0, p50 = 128, p95 = 235;
    var t05 = n * 0.05, t50 = n * 0.5, t95 = n * 0.95;
    for (var k = 0; k < 256; k++) {
      cum += hist[k];
      if (prev < t05 && cum >= t05) p05 = k;
      if (prev < t50 && cum >= t50) p50 = k;
      if (prev < t95 && cum >= t95) p95 = k;
      prev = cum;
    }

    return {
      L: sumL / n, a: sumA / n, b: sumB / n,
      sat: sumS / n,
      lowSat: lowSatN ? lowSatSum / lowSatN : 0,
      shadows: zavg(zones.sh), midtones: zavg(zones.mid), highlights: zavg(zones.hi),
      p05: p05, p50: p50, p95: p95, range: p95 - p05,
      hist: hist,
      skinRatio: skin / n,
      clipHigh: clipHi / n, clipLow: clipLo / n,
      samples: n
    };
  }

  /* ═══════════════ casamento ═══════════════ */

  /**
   * Calcula os controles do Lumetri que levam `src` até `ref`.
   *
   * @param {Object} src  perfil do clipe (analyze)
   * @param {Object} ref  perfil da referência (analyze)
   * @param {Object} [opt]
   * @param {number} [opt.strength=1]      0..1
   * @param {boolean}[opt.protectSkin=true]
   * @param {boolean}[opt.matchContrast=true]
   * @param {boolean}[opt.matchColor=true]
   * @returns {Object} { basic, wheels, meta }
   */
  function match(src, ref, opt) {
    opt = opt || {};
    var k = opt.strength == null ? 1 : clamp(opt.strength, 0, 1);
    var doColor = opt.matchColor !== false;
    var doContrast = opt.matchContrast !== false;

    /* ── proteção de pele ──
       Quanto mais pele no clipe, menos agressivo o desvio de croma, para não
       deixar o rosto verde ou magenta. */
    var skinDamp = 1;
    if (opt.protectSkin !== false && src.skinRatio > 0.04) {
      skinDamp = clamp(1 - src.skinRatio * 1.6, 0.35, 1);
    }

    /* ── luminância ── */
    // ~20 L* por stop
    var exposure = (ref.L - src.L) / 20;

    // ponto de preto e de branco, em 0-255
    var blacks = (ref.p05 - src.p05) * 0.75;
    var whites = (ref.p95 - src.p95) * 0.55;

    // contraste pela diferença de alcance dinâmico
    var contrast = doContrast ? (ref.range - src.range) * 0.55 : 0;

    // sombras e altas pelas médias de zona
    var shadows = (ref.shadows.L - src.shadows.L) * 1.15;
    var highlights = (ref.highlights.L - src.highlights.L) * 1.0;

    /* ── cor ──
       Em LAB: b* é o eixo azul(-)/amarelo(+) -> temperatura.
               a* é o eixo verde(-)/magenta(+) -> matiz. */
    var db = ref.b - src.b, da = ref.a - src.a;
    var temperature = doColor ? db * 2.1 * skinDamp : 0;
    var tint        = doColor ? da * 1.6 * skinDamp : 0;

    /* ── saturação ── */
    var satRatio = src.sat > 0.01 ? ref.sat / src.sat : 1;
    var saturation = doColor ? 100 * Math.pow(satRatio, 0.75) : 100;
    // vibração puxa só o que está pouco saturado
    var vibrance = doColor ? (ref.lowSat - src.lowSat) * 110 * skinDamp : 0;

    /* ── rodas de cor: desvio de croma por zona ── */
    var W = 0.0075; // LAB -> unidade interna do Lumetri, conservador
    function wheel(rz, sz) {
      if (!doColor) return { r: 0, g: 0, b: 0 };
      var dA = (rz.a - sz.a) * skinDamp, dB = (rz.b - sz.b) * skinDamp;
      // a* positivo = magenta (sobe R, desce G); b* positivo = amarelo (sobe R+G, desce B)
      return {
        r: clamp((dA * 0.6 + dB * 0.35) * W, -0.5, 0.5),
        g: clamp((-dA * 0.5 + dB * 0.35) * W, -0.5, 0.5),
        b: clamp((-dB * 0.75) * W, -0.5, 0.5)
      };
    }
    var wheels = {
      shadows: wheel(ref.shadows, src.shadows),
      midtones: wheel(ref.midtones, src.midtones),
      highlights: wheel(ref.highlights, src.highlights)
    };

    /* ── trava anti-clipping ──
       Se o clipe já estoura, ou se a correção vai estourar, recua. */
    var guard = 1;
    var projectedWhite = src.p95 + whites + exposure * 18;
    if (projectedWhite > 250) guard = Math.min(guard, clamp(1 - (projectedWhite - 250) / 40, 0.4, 1));
    if (src.clipHigh > 0.02) guard = Math.min(guard, 0.75);
    if (src.clipLow > 0.05) guard = Math.min(guard, 0.85);

    var f = k * guard;
    function s(v, key) { return lim(v * f, key); }

    var basic = {
      exposure:    +(clamp(exposure * f, LIM.exposure.min, LIM.exposure.max)).toFixed(3),
      contrast:    Math.round(s(contrast, 'contrast')),
      highlights:  Math.round(s(highlights, 'highlights')),
      shadows:     Math.round(s(shadows, 'shadows')),
      whites:      Math.round(s(whites, 'whites')),
      blacks:      Math.round(s(blacks, 'blacks')),
      temperature: +(s(temperature, 'temperature')).toFixed(1),
      tint:        +(s(tint, 'tint')).toFixed(1),
      // saturação interpola a partir de 100 (neutro), não escala
      saturation:  +(clamp(100 + (saturation - 100) * f, LIM.saturation.min, LIM.saturation.max)).toFixed(1),
      vibrance:    +(s(vibrance, 'vibrance')).toFixed(1)
    };

    var scaled = {};
    ['shadows', 'midtones', 'highlights'].forEach(function (z) {
      scaled[z] = { r: wheels[z].r * f, g: wheels[z].g * f, b: wheels[z].b * f };
    });

    return {
      basic: basic,
      wheels: scaled,
      meta: {
        mode: 'match',
        strength: Math.round(k * 100),
        guard: +guard.toFixed(2),
        skinRatio: +(src.skinRatio * 100).toFixed(1),
        skinDamp: +skinDamp.toFixed(2),
        deltaL: +(ref.L - src.L).toFixed(1),
        deltaA: +da.toFixed(1),
        deltaB: +db.toFixed(1),
        clipHigh: +(src.clipHigh * 100).toFixed(1),
        clipLow: +(src.clipLow * 100).toFixed(1),
        look: describe(ref),
        distance: distance(src, ref)
      }
    };
  }

  /**
   * Sem frame do clipe, faz o que dá: usa um alvo neutro de cinema como
   * origem. É pior que o casamento real e o painel avisa.
   */
  var NEUTRAL = {
    L: 48, a: 0.5, b: 2.0, sat: 0.30, lowSat: 0.14,
    shadows:   { L: 16, a: 0.4, b: 1.0, n: 1 },
    midtones:  { L: 52, a: 0.5, b: 2.0, n: 1 },
    highlights:{ L: 86, a: 0.4, b: 2.4, n: 1 },
    p05: 16, p50: 122, p95: 232, range: 216,
    skinRatio: 0, clipHigh: 0, clipLow: 0, samples: 1
  };
  function matchNeutral(ref, opt) {
    var r = match(NEUTRAL, ref, opt);
    r.meta.mode = 'estimate';
    return r;
  }

  /** Distância perceptual entre dois perfis. 0 = idênticos. */
  function distance(a, b) {
    var dL = a.L - b.L, dA = a.a - b.a, dB = a.b - b.b;
    var dS = (a.sat - b.sat) * 100, dR = (a.range - b.range) * 0.35;
    return +Math.sqrt(dL * dL + dA * dA + dB * dB + dS * dS + dR * dR).toFixed(1);
  }

  /** Rótulo curto do look de um perfil. */
  function describe(p) {
    if (p.L > 66) return 'High key';
    if (p.L < 32) return 'Low key';
    if (p.b < -6) return 'Frio';
    if (p.b > 14) return 'Quente';
    if (p.range < 110) return 'Flat';
    if (p.sat > 0.5) return 'Saturado';
    if (p.sat < 0.16) return 'Dessaturado';
    if (p.highlights.L - p.shadows.L > 62) return 'Contrastado';
    return 'Neutro';
  }

  /* ═══════════════ pré-visualização ═══════════════ */

  /**
   * Aplica os parâmetros num ImageData. É a mesma ordem que o Lumetri usa,
   * para o antes/depois do painel bater com o resultado no Premiere.
   */
  function preview(srcData, p) {
    var out = new Uint8ClampedArray(srcData.data);
    var B = p.basic, W = p.wheels;
    var exp = Math.pow(2, B.exposure);
    var ct = 1 + B.contrast / 100;
    var temp = B.temperature / 100, tint = B.tint / 100;
    var sat = B.saturation / 100, vib = B.vibrance / 100;
    var hlA = B.highlights / 100, shA = B.shadows / 100;
    var whA = B.whites / 100, blA = B.blacks / 100;

    for (var i = 0; i < out.length; i += 4) {
      var r = out[i] / 255, g = out[i + 1] / 255, b = out[i + 2] / 255;

      // exposição em luz linear
      r = Math.pow(Math.max(0, Math.pow(r, 2.2) * exp), 1 / 2.2);
      g = Math.pow(Math.max(0, Math.pow(g, 2.2) * exp), 1 / 2.2);
      b = Math.pow(Math.max(0, Math.pow(b, 2.2) * exp), 1 / 2.2);

      // balanço de branco
      r *= 1 + temp * 0.55 + tint * 0.10;
      g *= 1 - Math.abs(temp) * 0.06 + tint * 0.30;
      b *= 1 - temp * 0.55 + tint * 0.10;

      // contraste com pivô em 0.5
      r = (r - 0.5) * ct + 0.5; g = (g - 0.5) * ct + 0.5; b = (b - 0.5) * ct + 0.5;

      var L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var mH = Math.max(0, (L - 0.5) * 2), mS = Math.max(0, (0.5 - L) * 2);
      var mW = Math.max(0, (L - 0.75) * 4), mB = Math.max(0, (0.25 - L) * 4);
      var add = hlA * 0.42 * mH + shA * 0.42 * mS + whA * 0.32 * mW - blA * 0.32 * mB;
      r += add; g += add; b += add;

      var mM = 1 - Math.abs(L - 0.5) * 2;
      r += (W.shadows.r * mS + W.midtones.r * mM + W.highlights.r * mH) * 1.5;
      g += (W.shadows.g * mS + W.midtones.g * mM + W.highlights.g * mH) * 1.5;
      b += (W.shadows.b * mS + W.midtones.b * mM + W.highlights.b * mH) * 1.5;

      // saturação e vibração
      var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var chroma = Math.max(r, g, b) - Math.min(r, g, b);
      var s = sat + vib * 0.55 * (1 - Math.min(1, chroma * 1.6));
      r = lum + (r - lum) * s; g = lum + (g - lum) * s; b = lum + (b - lum) * s;

      out[i] = r * 255; out[i + 1] = g * 255; out[i + 2] = b * 255;
      out[i + 3] = srcData.data[i + 3];
    }
    return out;
  }

  /**
   * Gera um arquivo .cube 3D LUT a partir dos parâmetros de correção de cor calculados.
   * @param {Object} params { basic, wheels }
   * @param {number} [size=33] Tamanho da grade 3D (33x33x33)
   * @returns {string} Conteúdo em texto formatado no padrão Adobe .cube
   */
  function generateCube(params, size) {
    size = size || 33;
    var lines = [
      '# Master Color 3D LUT',
      '# Created by Alex Ascencio',
      'LUT_3D_SIZE ' + size,
      ''
    ];

    var B = params.basic, W = params.wheels;
    var exp = Math.pow(2, B.exposure);
    var temp = B.temperature / 100, tint = B.tint / 100;
    var ct = 1 + (B.contrast / 100) * 0.9;
    var sat = B.saturation / 100, vib = B.vibrance / 100;
    var hlA = B.highlights / 100, shA = B.shadows / 100;
    var whA = B.whites / 100, blA = B.blacks / 100;

    for (var bIdx = 0; bIdx < size; bIdx++) {
      var inB = bIdx / (size - 1);
      for (var gIdx = 0; gIdx < size; gIdx++) {
        var inG = gIdx / (size - 1);
        for (var rIdx = 0; rIdx < size; rIdx++) {
          var inR = rIdx / (size - 1);

          var r = inR, g = inG, b = inB;

          // exposição
          r = Math.pow(Math.max(0, Math.pow(r, 2.2) * exp), 1 / 2.2);
          g = Math.pow(Math.max(0, Math.pow(g, 2.2) * exp), 1 / 2.2);
          b = Math.pow(Math.max(0, Math.pow(b, 2.2) * exp), 1 / 2.2);

          // balanço de branco
          r *= 1 + temp * 0.55 + tint * 0.10;
          g *= 1 - Math.abs(temp) * 0.06 + tint * 0.30;
          b *= 1 - temp * 0.55 + tint * 0.10;

          // contraste
          r = (r - 0.5) * ct + 0.5; g = (g - 0.5) * ct + 0.5; b = (b - 0.5) * ct + 0.5;

          var L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          var mH = Math.max(0, (L - 0.5) * 2), mS = Math.max(0, (0.5 - L) * 2);
          var mW = Math.max(0, (L - 0.75) * 4), mB = Math.max(0, (0.25 - L) * 4);
          var add = hlA * 0.42 * mH + shA * 0.42 * mS + whA * 0.32 * mW - blA * 0.32 * mB;
          r += add; g += add; b += add;

          var mM = 1 - Math.abs(L - 0.5) * 2;
          r += (W.shadows.r * mS + W.midtones.r * mM + W.highlights.r * mH) * 1.5;
          g += (W.shadows.g * mS + W.midtones.g * mM + W.highlights.g * mH) * 1.5;
          b += (W.shadows.b * mS + W.midtones.b * mM + W.highlights.b * mH) * 1.5;

          // saturação
          var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          var chroma = Math.max(r, g, b) - Math.min(r, g, b);
          var s = sat + vib * 0.55 * (1 - Math.min(1, chroma * 1.6));
          r = lum + (r - lum) * s; g = lum + (g - lum) * s; b = lum + (b - lum) * s;

          r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1);

          lines.push(r.toFixed(6) + ' ' + g.toFixed(6) + ' ' + b.toFixed(6));
        }
      }
    }
    return lines.join('\n');
  }

  return {
    LIMITS: LIM,
    analyze: analyze,
    match: match,
    matchNeutral: matchNeutral,
    preview: preview,
    neutralParams: neutralParams,
    distance: distance,
    describe: describe,
    rgbToLab: rgbToLab,
    isSkin: isSkin,
    generateCube: generateCube,
    _NEUTRAL: NEUTRAL
  };
});

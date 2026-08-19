/**
 * Master Color — lógica do painel
 * Alex Ascencio · Adobe Premiere Pro
 */
(function () {
  'use strict';

  var MC = window.MasterColor;
  var $ = function (s) { return document.querySelector(s); };

  /* ═══════════════ ponte com o Premiere ═══════════════ */
  var cs = (typeof CSInterface === 'function') ? new CSInterface() : null;
  var hostOk = false;

  function evalScript(fn, arg, cb) {
    if (!cs) { if (cb) cb(null); return; }
    var call = arg === undefined
      ? fn + '()'
      : fn + '(' + JSON.stringify(JSON.stringify(arg)) + ')';
    cs.evalScript(call, function (res) {
      if (cb) cb(res === 'undefined' || res === 'EvalScript error.' ? null : res);
    });
  }
  function evalJSON(fn, arg, cb) {
    evalScript(fn, arg, function (raw) {
      if (!raw) return cb(null);
      try { cb(JSON.parse(raw)); } catch (e) { cb(null); }
    });
  }

  function req(m) { try { return window.require ? window.require(m) : null; } catch (e) { return null; } }
  var fs = req('fs'), pathM = req('path'), os = req('os'), cp = req('child_process');

  /* ═══════════════ estado ═══════════════ */
  var S = {
    ref: null,        // perfil da referência
    clip: null,       // perfil do clipe
    refData: null,    // ImageData da referência
    clipData: null,   // ImageData do clipe
    params: null,
    opt: { strength: 1, protectSkin: true, matchColor: true, matchContrast: true },
    showAfter: false
  };

  var cvClip = $('#cvClip'), ctxClip = cvClip.getContext('2d', { willReadFrequently: true });
  var cvRef = $('#cvRef'), ctxRef = cvRef.getContext('2d', { willReadFrequently: true });
  var cvScope = $('#cvScope'), ctxScope = cvScope.getContext('2d');

  function status(txt, kind) {
    $('#stat').textContent = txt;
    $('#dot').className = 'dot' + (kind ? ' ' + kind : '');
  }

  /* ═══════════════ sliders do Lumetri ═══════════════ */
  var SL = [
    ['exposure', 'Exposição', 2], ['contrast', 'Contraste', 0],
    ['highlights', 'Realces', 0], ['shadows', 'Sombras', 0],
    ['whites', 'Brancos', 0], ['blacks', 'Pretos', 0],
    ['temperature', 'Temp', 1], ['tint', 'Matiz', 1],
    ['saturation', 'Saturação', 1], ['vibrance', 'Vibração', 1]
  ];
  var slRef = {};
  (function buildSliders() {
    var box = $('#lum');
    SL.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'sl';
      d.innerHTML = '<div class="sl-h"><span>' + s[1] + '</span><b>—</b></div>' +
                    '<div class="sl-t"><i class="sl-f"></i></div>';
      box.appendChild(d);
      slRef[s[0]] = { v: d.querySelector('b'), f: d.querySelector('.sl-f'), dec: s[2] };
    });
  })();

  function paintSliders(p) {
    SL.forEach(function (s) {
      var key = s[0], R = slRef[key], L = MC.LIMITS[key];
      var val = p ? p.basic[key] : (key === 'saturation' ? 100 : 0);
      var neutral = key === 'saturation' ? 100 : 0;
      var pv = (val - L.min) / (L.max - L.min) * 100;
      var pn = (neutral - L.min) / (L.max - L.min) * 100;
      R.f.style.left = Math.min(pv, pn) + '%';
      R.f.style.width = Math.abs(pv - pn) + '%';
      R.f.classList.toggle('pos', val > neutral);
      R.v.textContent = (val > 0 && neutral === 0 ? '+' : '') + Number(val).toFixed(R.dec);
    });
  }

  function paintWheels(p) {
    [['#whS', 'shadows'], ['#whM', 'midtones'], ['#whH', 'highlights']].forEach(function (k) {
      var w = p ? p.wheels[k[1]] : { r: 0, g: 0, b: 0 };
      var x = Math.max(-16, Math.min(16, (w.r - w.b) * 900));
      var y = Math.max(-16, Math.min(16, (w.b + w.r - 2 * w.g) * -600));
      $(k[0]).style.transform = 'translate(calc(-50% + ' + x.toFixed(1) + 'px),calc(-50% + ' + y.toFixed(1) + 'px))';
    });
  }

  /* ═══════════════ escopo ═══════════════ */
  function paintScope() {
    var w = cvScope.width, h = cvScope.height;
    ctxScope.clearRect(0, 0, w, h);
    ctxScope.fillStyle = 'rgba(255,255,255,.05)';
    for (var g = 1; g < 4; g++) ctxScope.fillRect(w * g / 4, 0, 1, h);

    function curve(hist, color, fill) {
      var mx = 1;
      for (var i = 1; i < 255; i++) if (hist[i] > mx) mx = hist[i];
      ctxScope.beginPath();
      ctxScope.moveTo(0, h);
      for (var k = 0; k < 256; k++) {
        ctxScope.lineTo(k / 255 * w, h - Math.pow(hist[k] / mx, 0.55) * h * 0.92);
      }
      ctxScope.lineTo(w, h);
      ctxScope.closePath();
      if (fill) { ctxScope.fillStyle = fill; ctxScope.fill(); }
      ctxScope.strokeStyle = color; ctxScope.lineWidth = 1.6; ctxScope.stroke();
    }
    if (S.clip) curve(S.clip.hist, 'rgba(236,231,222,.55)', 'rgba(236,231,222,.07)');
    if (S.ref) curve(S.ref.hist, '#2ed3b7', 'rgba(46,211,183,.12)');
  }

  /* ═══════════════ métricas ═══════════════ */
  function paintMets() {
    var box = $('#mets');
    box.innerHTML = '';
    if (!S.params) { box.innerHTML = '<span class="empty">sem leitura</span>'; return; }
    var m = S.params.meta;
    function chip(label, val, cls) {
      var e = document.createElement('span');
      e.className = 'met' + (cls ? ' ' + cls : '');
      e.innerHTML = label + ' <b>' + val + '</b>';
      box.appendChild(e);
    }
    chip('ΔL', (m.deltaL > 0 ? '+' : '') + m.deltaL);
    chip('Δa', (m.deltaA > 0 ? '+' : '') + m.deltaA);
    chip('Δb', (m.deltaB > 0 ? '+' : '') + m.deltaB, 'a');
    if (m.skinRatio > 4) chip('pele', m.skinRatio + '%', 't');
    if (m.guard < 1) chip('trava', Math.round(m.guard * 100) + '%', 'w');
    if (m.clipHigh > 1) chip('clip ↑', m.clipHigh + '%', 'w');
  }

  /* ═══════════════ cálculo ═══════════════ */
  function recompute() {
    if (!S.ref) { S.params = null; paintAll(); return; }
    S.params = S.clip ? MC.match(S.clip, S.ref, S.opt) : MC.matchNeutral(S.ref, S.opt);

    var real = S.params.meta.mode === 'match';
    $('#modeTag').textContent = real ? 'casamento real' : 'estimativa';
    $('#modeTag').className = real ? '' : 'warn';
    $('#secNote').hidden = real;
    $('#lookTag').textContent = S.params.meta.look || '—';
    $('#distTag').textContent = S.clip ? 'distância ' + MC.distance(S.clip, S.ref) : '—';

    $('#btnApply').disabled = !hostOk;
    $('#btnSaveLook').disabled = false;
    $('#btnPreview').disabled = !S.clipData;
    paintAll();
  }

  function paintAll() {
    paintSliders(S.params);
    paintWheels(S.params);
    paintScope();
    paintMets();
    if (S.clipData) drawClip();
  }

  function drawClip() {
    if (!S.clipData) return;
    if (S.showAfter && S.params) {
      var out = MC.preview(S.clipData, S.params);
      ctxClip.putImageData(new ImageData(out, S.clipData.width, S.clipData.height), 0, 0);
    } else {
      ctxClip.putImageData(S.clipData, 0, 0);
    }
  }

  /* ═══════════════ carregar imagens ═══════════════ */
  function drawInto(ctx, cv, img) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    var s = Math.max(cv.width / img.width, cv.height / img.height);
    var w = img.width * s, h = img.height * s;
    ctx.drawImage(img, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
    return ctx.getImageData(0, 0, cv.width, cv.height);
  }

  function loadRefImage(src, name) {
    var img = new Image();
    img.onload = function () {
      S.refData = drawInto(ctxRef, cvRef, img);
      S.ref = MC.analyze(S.refData);
      $('#slotRef').classList.add('filled');
      status('Referência lida', 'on');
      $('#ftInfo').textContent = name ? name.slice(0, 26) : 'referência';
      recompute();
    };
    img.onerror = function () { status('Imagem inválida', 'err'); };
    img.src = src;
  }

  function loadRefFile(f) {
    if (!f || f.type.indexOf('image/') !== 0) return;
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      S.refData = drawInto(ctxRef, cvRef, img);
      S.ref = MC.analyze(S.refData);
      $('#slotRef').classList.add('filled');
      URL.revokeObjectURL(url);
      status('Referência lida', 'on');
      $('#ftInfo').textContent = f.name.replace(/\.[^.]+$/, '').slice(0, 26);
      recompute();
    };
    img.src = url;
  }

  /* ═══════════════ ler o frame do clipe ═══════════════ */
  function extractFrameFromSource(mediaPath, timeSec, clipName) {
    var ext = (mediaPath.split('.').pop() || '').toLowerCase();
    var isImage = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp', 'webp'].indexOf(ext) >= 0;

    // Imagem estática: lê diretamente com fs ou Image()
    if (isImage) {
      try {
        if (fs && fs.readFileSync) {
          var buf = fs.readFileSync(mediaPath);
          var b64 = buf.toString('base64');
          var mime = ext === 'png' ? 'image/png' : 'image/jpeg';
          var img = new Image();
          img.onload = function () {
            S.clipData = drawInto(ctxClip, cvClip, img);
            S.clip = MC.analyze(S.clipData);
            $('#slotClip').classList.add('filled');
            status('Clipe lido (' + (clipName || 'imagem').slice(0, 18) + ')', 'on');
            recompute();
          };
          img.onerror = function () { status('Imagem ilegível', 'err'); };
          img.src = 'data:' + mime + ';base64,' + b64;
          return;
        }
      } catch (eImg) {}
    }

    // Vídeo: carrega via elemento <video> HTML5 no Chromium do CEP
    var norm = mediaPath.replace(/\\/g, '/');
    var fileUrl = norm.startsWith('/') ? 'file://' + encodeURI(norm) : 'file:///' + encodeURI(norm);
    var vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.muted = true;
    vid.preload = 'auto';
    vid.src = fileUrl;

    var captured = false;
    function capture() {
      if (captured) return;
      captured = true;
      try {
        S.clipData = drawInto(ctxClip, cvClip, vid);
        S.clip = MC.analyze(S.clipData);
        $('#slotClip').classList.add('filled');
        status('Clipe lido (' + (clipName || 'vídeo').slice(0, 18) + ')', 'on');
        recompute();
      } catch (eCap) {
        status('Erro ao capturar frame', 'err');
      }
    }

    vid.onloadedmetadata = function () {
      var targetTime = Math.max(0, Math.min(timeSec || 0, vid.duration || 9999));
      vid.currentTime = targetTime;
    };
    vid.onseeked = function () {
      capture();
    };

    // Timeout de segurança se o codec precisar de FFmpeg (ex: ProRes/DNxHD)
    var timer = setTimeout(function () {
      if (!captured) {
        extractViaFfmpeg(mediaPath, timeSec, clipName);
      }
    }, 1500);

    vid.onerror = function () {
      clearTimeout(timer);
      extractViaFfmpeg(mediaPath, timeSec, clipName);
    };
  }

  function extractViaFfmpeg(mediaPath, timeSec, clipName) {
    if (!cp || !os || !pathM) {
      status('Codec não suportado no preview', 'err');
      return;
    }
    var outPng = pathM.join(os.tmpdir(), 'mastercolor-ffmpeg-' + Date.now() + '.png');
    var appData = (typeof process !== 'undefined' && process.env && process.env.APPDATA) ? process.env.APPDATA : '';
    var candidates = [
      'ffmpeg',
      pathM.join(appData, 'Adobe', 'CEP', 'extensions', 'com.alexascencio.mypackspro', 'bin', 'win', 'ffmpeg.exe'),
      pathM.join(appData, 'MyPacksPro', 'bin', 'win', 'ffmpeg.exe'),
      'd:\\IA\\02_Plugins\\ADOBE PREMIERE\\My Packs Pro\\bin\\win\\ffmpeg.exe'
    ];

    function tryNextFfmpeg(idx) {
      if (idx >= candidates.length) {
        status('Instale FFmpeg para codecs PRO', 'err');
        return;
      }
      var bin = candidates[idx];
      var args = [
        '-ss', String(timeSec || 0),
        '-i', mediaPath,
        '-vframes', '1',
        '-vf', 'scale=-2:240:flags=fast_bilinear',
        '-y',
        outPng
      ];
      var cmd = '"' + bin + '" ' + args.map(function (a) { return '"' + a + '"'; }).join(' ');
      cp.exec(cmd, { timeout: 4000 }, function (err) {
        if (!err && fs && fs.existsSync(outPng)) {
          try {
            var buf = fs.readFileSync(outPng);
            var b64 = buf.toString('base64');
            var img = new Image();
            img.onload = function () {
              S.clipData = drawInto(ctxClip, cvClip, img);
              S.clip = MC.analyze(S.clipData);
              $('#slotClip').classList.add('filled');
              status('Clipe lido (' + (clipName || 'frame').slice(0, 18) + ')', 'on');
              try { fs.unlinkSync(outPng); } catch (e) {}
              recompute();
            };
            img.src = 'data:image/png;base64,' + b64;
            return;
          } catch (eRead) {}
        }
        tryNextFfmpeg(idx + 1);
      });
    }

    tryNextFfmpeg(0);
  }

  function readClipFrame() {
    if (!cs) { status('Sem Premiere', 'err'); return; }
    status('Lendo frame…', 'busy');
    $('#btnReadClip').disabled = true;

    var out = null;
    try {
      out = pathM && os ? pathM.join(os.tmpdir(), 'mastercolor-frame.png') : null;
    } catch (e) {}
    if (!out) {
      status('Sem acesso a disco', 'err');
      $('#btnReadClip').disabled = false;
      return;
    }

    evalJSON('exportCurrentFrame', { path: out }, function (res) {
      $('#btnReadClip').disabled = false;
      if (!res || !res.ok) {
        status(res && res.error ? String(res.error).slice(0, 30) : 'Falha ao ler frame', 'err');
        return;
      }

      if (res.via === 'mediaSource' && res.mediaPath) {
        extractFrameFromSource(res.mediaPath, res.timeSec, res.name);
        return;
      }

      // lê o PNG exportado do disco como data URL
      try {
        var buf = fs.readFileSync(res.path);
        var b64 = buf.toString('base64');
        var img = new Image();
        img.onload = function () {
          S.clipData = drawInto(ctxClip, cvClip, img);
          S.clip = MC.analyze(S.clipData);
          $('#slotClip').classList.add('filled');
          status('Clipe lido', 'on');
          try { fs.unlinkSync(res.path); } catch (e) {}
          recompute();
        };
        img.onerror = function () { status('PNG ilegível', 'err'); };
        img.src = 'data:image/png;base64,' + b64;
      } catch (e) {
        status('Erro ao ler o frame', 'err');
      }
    });
  }

  /* ═══════════════ aplicar ═══════════════ */
  function apply() {
    if (!S.params || !hostOk) return;
    status('Aplicando…', 'busy');
    $('#btnApply').disabled = true;
    evalJSON('applyColorGrade', S.params, function (res) {
      $('#btnApply').disabled = false;
      if (res && res.ok) {
        status('Aplicado em ' + (res.count || 1) + ' clipe(s)', 'on');
      } else {
        status(res && res.error ? String(res.error).slice(0, 32) : 'Nada selecionado', 'err');
      }
    });
  }

  function reset() {
    if (!hostOk) { S.params = null; paintAll(); return; }
    status('Resetando…', 'busy');
    evalJSON('resetColorGrade', undefined, function (res) {
      status(res && res.ok ? 'Resetado' : 'Nada selecionado', res && res.ok ? 'on' : 'err');
      S.params = S.ref ? S.params : null;
      paintSliders(MC.neutralParams());
      paintWheels(MC.neutralParams());
    });
  }

  /* ═══════════════ looks salvos ═══════════════ */
  var LOOK_KEY = 'mastercolor_looks';
  function getLooks() {
    try { return JSON.parse(localStorage.getItem(LOOK_KEY) || '[]'); } catch (e) { return []; }
  }
  function setLooks(l) {
    try { localStorage.setItem(LOOK_KEY, JSON.stringify(l.slice(0, 24))); } catch (e) {}
  }
  function paintLooks() {
    var box = $('#looks'), looks = getLooks();
    box.innerHTML = '';
    if (!looks.length) { box.innerHTML = '<span class="empty">nenhum ainda</span>'; return; }
    looks.forEach(function (lk, i) {
      var b = document.createElement('button');
      b.className = 'look';
      b.innerHTML = escapeHtml(lk.name) + '<x>&times;</x>';
      b.onclick = function (e) {
        if (e.target.tagName === 'X') {
          var l = getLooks(); l.splice(i, 1); setLooks(l); paintLooks();
          return;
        }
        S.ref = lk.profile;
        S.refData = null;
        ctxRef.fillStyle = '#0c0c11';
        ctxRef.fillRect(0, 0, cvRef.width, cvRef.height);
        ctxRef.fillStyle = '#2ed3b7';
        ctxRef.font = '600 22px system-ui';
        ctxRef.textAlign = 'center';
        ctxRef.fillText(lk.name.slice(0, 14), cvRef.width / 2, cvRef.height / 2 + 8);
        $('#slotRef').classList.add('filled');
        $('#ftInfo').textContent = lk.name;
        status('Look carregado', 'on');
        recompute();
      };
      box.appendChild(b);
    });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function saveLook() {
    if (!S.ref) return;
    var name = prompt('Nome do look:', ($('#ftInfo').textContent || 'Look').slice(0, 18));
    if (!name) return;
    var looks = getLooks();
    looks.unshift({ name: name.slice(0, 18), profile: S.ref });
    setLooks(looks);
    paintLooks();
  }

  /* ═══════════════ eventos ═══════════════ */
  var slotRef = $('#slotRef'), file = $('#file');
  slotRef.onclick = function () { file.click(); };
  file.onchange = function () { loadRefFile(file.files[0]); };

  ['dragenter', 'dragover'].forEach(function (ev) {
    slotRef.addEventListener(ev, function (e) { e.preventDefault(); slotRef.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    slotRef.addEventListener(ev, function (e) { e.preventDefault(); slotRef.classList.remove('drag'); });
  });
  slotRef.addEventListener('drop', function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) loadRefFile(e.dataTransfer.files[0]);
  });

  $('#slotClip').onclick = readClipFrame;
  $('#btnReadClip').onclick = readClipFrame;

  $('#btnPaste').onclick = function () {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      status('Colar indisponível', 'err'); return;
    }
    navigator.clipboard.read().then(function (items) {
      for (var i = 0; i < items.length; i++) {
        var types = items[i].types;
        for (var t = 0; t < types.length; t++) {
          if (types[t].indexOf('image/') === 0) {
            return items[i].getType(types[t]).then(function (blob) {
              loadRefFile(new File([blob], 'colado.png', { type: blob.type }));
            });
          }
        }
      }
      status('Sem imagem na área', 'err');
    }).catch(function () { status('Colar bloqueado', 'err'); });
  };

  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        loadRefFile(items[i].getAsFile());
        e.preventDefault();
        return;
      }
    }
  });

  var str = $('#strength');
  str.oninput = function () {
    S.opt.strength = +str.value / 100;
    $('#strVal').textContent = str.value + '%';
    recompute();
  };

  [].forEach.call(document.querySelectorAll('.sw'), function (sw) {
    sw.onclick = function () {
      var on = sw.getAttribute('aria-pressed') !== 'true';
      sw.setAttribute('aria-pressed', on);
      S.opt[sw.dataset.o] = on;
      recompute();
    };
  });

  $('#btnApply').onclick = apply;
  $('#btnReset').onclick = reset;
  $('#btnSaveLook').onclick = saveLook;
  $('#btnPreview').onclick = function () {
    S.showAfter = !S.showAfter;
    this.textContent = S.showAfter ? 'Ver antes' : 'Antes / depois';
    drawClip();
  };

  /* ═══════════════ arranque ═══════════════ */
  paintSliders(null);
  paintWheels(null);
  paintMets();
  paintLooks();
  ctxClip.fillStyle = '#0c0c11'; ctxClip.fillRect(0, 0, cvClip.width, cvClip.height);
  ctxRef.fillStyle = '#0c0c11'; ctxRef.fillRect(0, 0, cvRef.width, cvRef.height);

  if (!cs) {
    status('Fora do Premiere', 'err');
    $('#ftInfo').textContent = 'modo avulso';
  } else {
    evalJSON('getPluginInfo', undefined, function (info) {
      if (info && info.ok) {
        hostOk = true;
        status(info.sequence ? info.sequence.slice(0, 18) : 'Pronto', 'on');
        $('#ftInfo').textContent = info.project ? info.project.slice(0, 22) : 'Premiere';
        if (S.params) $('#btnApply').disabled = false;
      } else {
        status('Abra uma sequência', 'err');
      }
    });
  }
})();

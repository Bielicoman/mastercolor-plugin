/**
 * Master Color — ponte ExtendScript
 * Alex Ascencio · Adobe Premiere Pro
 *
 * Todas as funções devolvem JSON como string. Nunca lançam para o painel:
 * erro vira { ok:false, error:"..." } para o painel poder mostrar a causa real.
 */

/* ═══════════════ utilidades ═══════════════ */

function mcJSON(obj) {
    // Premiere não tem JSON nativo confiável em todas as versões.
    if (typeof JSON !== 'undefined' && JSON.stringify) {
        try { return JSON.stringify(obj); } catch (e) {}
    }
    return mcSerialize(obj);
}

function mcSerialize(v) {
    var t = typeof v;
    if (v === null || t === 'undefined') return 'null';
    if (t === 'number') return isFinite(v) ? String(v) : '0';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') {
        return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                      .replace(/[\r\n]/g, ' ') + '"';
    }
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(mcSerialize(v[i]));
        return '[' + a.join(',') + ']';
    }
    var p = [];
    for (var k in v) {
        if (v.hasOwnProperty(k)) p.push('"' + k + '":' + mcSerialize(v[k]));
    }
    return '{' + p.join(',') + '}';
}

function mcParse(str) {
    if (!str) return null;
    try {
        if (typeof JSON !== 'undefined' && JSON.parse) return JSON.parse(str);
        return eval('(' + str + ')');
    } catch (e) { return null; }
}

function mcErr(msg) { return mcJSON({ ok: false, error: String(msg) }); }

function mcSeq() {
    if (!app || !app.project) return null;
    return app.project.activeSequence || null;
}

/* ═══════════════ informação básica ═══════════════ */

function getPluginInfo() {
    try {
        if (!app || !app.project) return mcErr('Premiere sem projeto');
        var seq = mcSeq();
        return mcJSON({
            ok: true,
            version: app.version || '',
            project: app.project.name || '',
            sequence: seq ? seq.name : '',
            hasSequence: !!seq
        });
    } catch (e) { return mcErr(e); }
}

/* ═══════════════ seleção ═══════════════ */

function mcSelection() {
    var seq = mcSeq();
    if (!seq) return { err: 'Nenhuma sequência aberta' };
    var sel = [];
    try {
        if (seq.getSelection) {
            var s = seq.getSelection();
            for (var i = 0; i < s.length; i++) sel.push(s[i]);
        }
    } catch (e) {}
    if (!sel.length) {
        // sem seleção: usa o clipe sob o playhead na trilha de vídeo mais alta
        try {
            var t = seq.getPlayerPosition().seconds;
            for (var v = seq.videoTracks.numTracks - 1; v >= 0; v--) {
                var tr = seq.videoTracks[v];
                for (var c = 0; c < tr.clips.numItems; c++) {
                    var cl = tr.clips[c];
                    var cStart = cl.start ? cl.start.seconds : 0;
                    var cEnd = cl.end ? cl.end.seconds : (cStart + (cl.duration ? cl.duration.seconds : 0));
                    if (cStart <= t && cEnd >= t) { sel.push(cl); break; }
                }
                if (sel.length) break;
            }
        } catch (e2) {}
    }
    if (!sel.length) return { err: 'Selecione um clipe na timeline' };
    return { clips: sel };
}

function getSelectedClipsInfo() {
    try {
        var r = mcSelection();
        if (r.err) return mcErr(r.err);
        var out = [];
        for (var i = 0; i < r.clips.length; i++) {
            out.push({
                name: r.clips[i].name || '',
                start: r.clips[i].start ? r.clips[i].start.seconds : 0,
                duration: r.clips[i].duration ? r.clips[i].duration.seconds : 0
            });
        }
        return mcJSON({ ok: true, count: out.length, clips: out });
    } catch (e) { return mcErr(e); }
}

/* ═══════════════ exportar o frame atual ═══════════════ */

/**
 * Exporta o frame sob o playhead para PNG ou localiza a mídia do clipe ativo.
 *
 * Estratégia multi-camadas:
 *   1. Sequence.exportFramePNG nativo (ticks, Time, seconds)
 *   2. QE DOM (seconds, timecode, CTI)
 *   3. Fonte do Clipe no disco (mediaPath + offset em segundos para leitura instantânea)
 */
function exportCurrentFrame(argJson) {
    try {
        var arg = mcParse(argJson) || {};
        var out = arg.path;
        if (!out) return mcErr('caminho não informado');

        // Garante barras normais (POSIX) para o ExtendScript File e exportFramePNG
        out = String(out).replace(/\\/g, '/');

        var seq = mcSeq();
        if (!seq) return mcErr('Nenhuma sequência aberta');

        var t = seq.getPlayerPosition();

        // 1. API moderna Sequence.exportFramePNG
        if (typeof seq.exportFramePNG === 'function') {
            try {
                if (t && t.ticks) {
                    seq.exportFramePNG(String(t.ticks), out);
                    var f1a = new File(out);
                    if (f1a.exists && f1a.length > 0) return mcJSON({ ok: true, path: out, via: 'exportFramePNG_ticks' });
                }
            } catch (e1a) {}

            try {
                seq.exportFramePNG(t, out);
                var f1b = new File(out);
                if (f1b.exists && f1b.length > 0) return mcJSON({ ok: true, path: out, via: 'exportFramePNG_time' });
            } catch (e1b) {}

            try {
                seq.exportFramePNG(t.seconds, out);
                var f1c = new File(out);
                if (f1c.exists && f1c.length > 0) return mcJSON({ ok: true, path: out, via: 'exportFramePNG_sec' });
            } catch (e1c) {}
        }

        // 2. QE DOM
        try {
            if (typeof qe === 'undefined' || !qe) app.enableQE();
            if (typeof qe !== 'undefined' && qe && qe.project && qe.project.getActiveSequence) {
                var qseq = qe.project.getActiveSequence();
                if (qseq) {
                    if (typeof qseq.exportFramePNG === 'function') {
                        try {
                            qseq.exportFramePNG(t.seconds, out);
                            var f2a = new File(out);
                            if (f2a.exists && f2a.length > 0) return mcJSON({ ok: true, path: out, via: 'qe_sec' });
                        } catch (e2a) {}

                        try {
                            if (qseq.CTI && qseq.CTI.getTimecode) {
                                qseq.exportFramePNG(qseq.CTI.getTimecode(), out);
                                var f2b = new File(out);
                                if (f2b.exists && f2b.length > 0) return mcJSON({ ok: true, path: out, via: 'qe_tc' });
                            }
                        } catch (e2b) {}
                    }
                    if (qseq.CTI && typeof qseq.CTI.exportFramePNG === 'function') {
                        try {
                            qseq.CTI.exportFramePNG(out);
                            var f2c = new File(out);
                            if (f2c.exists && f2c.length > 0) return mcJSON({ ok: true, path: out, via: 'qe_cti' });
                        } catch (e2c) {}
                    }
                }
            }
        } catch (e2) {}

        // 3. Fallback infalível: Localiza o clipe de vídeo ativo sob o playhead
        try {
            var selRes = mcSelection();
            if (selRes.clips && selRes.clips.length > 0) {
                var cl = selRes.clips[0];
                var pItem = cl.projectItem;
                if (pItem) {
                    var mPath = '';
                    try { if (pItem.getMediaPath) mPath = pItem.getMediaPath(); } catch (eMedia) {}
                    if (!mPath) {
                        try { if (pItem.treePath) mPath = pItem.treePath; } catch (eTree) {}
                    }
                    if (mPath) {
                        var clStart = (cl.start && typeof cl.start.seconds === 'number') ? cl.start.seconds : 0;
                        var inPt = (cl.inPoint && typeof cl.inPoint.seconds === 'number') ? cl.inPoint.seconds : 0;
                        var playhead = t.seconds || 0;
                        var offsetSec = Math.max(0, (playhead - clStart) + inPt);
                        return mcJSON({
                            ok: true,
                            via: 'mediaSource',
                            mediaPath: mPath,
                            timeSec: offsetSec,
                            name: cl.name || pItem.name || 'frame'
                        });
                    }
                }
            }
        } catch (e3) {}

        return mcErr('Nenhum clipe de vídeo encontrado sob o playhead');
    } catch (e) { return mcErr(e); }
}

/* ═══════════════ Lumetri ═══════════════ */

var MC_LUMETRI_NAMES = [
    'Lumetri Color',
    'Cor Lumetri',
    'Cor de Lumetri',
    'Lumetri-Farbe',
    'Couleur Lumetri',
    'Color Lumetri',
    'Lumetri'
];

function mcIsLumetri(name) {
    if (!name) return false;
    var s = String(name).toLowerCase();
    return s.indexOf('lumetri') >= 0 || s.indexOf('cor lumetri') >= 0;
}

function mcFindLumetri(clip) {
    try {
        if (!clip || !clip.components) return null;
        for (var i = 0; i < clip.components.numItems; i++) {
            var c = clip.components[i];
            if (c && (mcIsLumetri(c.displayName) || mcIsLumetri(c.name) || mcIsLumetri(c.matchName))) return c;
        }
    } catch (e) {}
    return null;
}

function mcGetLumetriQE() {
    try {
        if (typeof qe === 'undefined' || !qe) app.enableQE();
        if (typeof qe === 'undefined' || !qe || !qe.project) return null;

        for (var i = 0; i < MC_LUMETRI_NAMES.length; i++) {
            try {
                var fx = qe.project.getVideoEffectByName(MC_LUMETRI_NAMES[i]);
                if (fx) return fx;
            } catch (e1) {}
            try {
                var fx2 = qe.project.getVideoEffectByName(MC_LUMETRI_NAMES[i], true);
                if (fx2) return fx2;
            } catch (e2) {}
        }

        try {
            if (qe.project.numVideoEffects) {
                for (var j = 0; j < qe.project.numVideoEffects; j++) {
                    var item = qe.project.getVideoEffectAt(j);
                    if (item && item.name && mcIsLumetri(item.name)) return item;
                }
            }
        } catch (e3) {}
    } catch (e) {}
    return null;
}

function mcAddLumetri(clip) {
    try {
        if (typeof qe === 'undefined' || !qe) app.enableQE();
        if (typeof qe === 'undefined' || !qe || !qe.project) return null;

        var fx = mcGetLumetriQE();
        if (!fx) return null;

        var seq = mcSeq();
        var qseq = qe.project.getActiveSequence();
        if (!seq || !qseq) return null;

        var cStart = (clip.start && typeof clip.start.seconds === 'number') ? clip.start.seconds : -1;

        // 1. Tenta mapear diretamente por track index e clip index exatos
        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            var tr = seq.videoTracks[v];
            var qtr = (v < qseq.numVideoTracks) ? qseq.getVideoTrackAt(v) : null;
            if (!qtr) continue;

            for (var c = 0; c < tr.clips.numItems; c++) {
                var isMatch = (tr.clips[c] === clip);
                if (!isMatch && clip.nodeId && tr.clips[c].nodeId === clip.nodeId) isMatch = true;
                if (!isMatch && cStart >= 0 && tr.clips[c].start && Math.abs(tr.clips[c].start.seconds - cStart) < 0.02) isMatch = true;

                if (isMatch) {
                    if (c < qtr.numItems) {
                        var targetQc = qtr.getItemAt(c);
                        if (targetQc && targetQc.addVideoEffect) {
                            try { targetQc.addVideoEffect(fx); } catch (eAdd1) {}
                            var found = mcFindLumetri(clip);
                            if (found) return found;
                        }
                    }
                }
            }
        }

        // 2. Tenta nos clipes QE por tempo / nome
        for (var v2 = 0; v2 < qseq.numVideoTracks; v2++) {
            var qtr2 = qseq.getVideoTrackAt(v2);
            for (var c2 = 0; c2 < qtr2.numItems; c2++) {
                var qc = qtr2.getItemAt(c2);
                if (qc) {
                    var qStart = (qc.start && typeof qc.start.seconds === 'number') ? qc.start.seconds : -2;
                    if (Math.abs(qStart - cStart) < 0.05 || qc.name === clip.name) {
                        if (qc.addVideoEffect) {
                            try { qc.addVideoEffect(fx); } catch (eAdd2) {}
                            var found2 = mcFindLumetri(clip);
                            if (found2) return found2;
                        }
                    }
                }
            }
        }
    } catch (e) {}
    return null;
}

/** Mapa: chave do painel -> nomes possíveis da propriedade no Lumetri. */
var MC_MAP = {
    exposure:    ['Exposure', 'Exposição', 'Exposicion', 'Belichtung', 'Basic Exposure'],
    contrast:    ['Contrast', 'Contraste', 'Kontrast', 'Basic Contrast'],
    highlights:  ['Highlights', 'Realces', 'Lichter', 'Altas luces', 'Basic Highlights'],
    shadows:     ['Shadows', 'Sombras', 'Tiefen', 'Basic Shadows'],
    whites:      ['Whites', 'Brancos', 'Weiß', 'Blancos', 'Basic Whites'],
    blacks:      ['Blacks', 'Pretos', 'Schwarz', 'Negros', 'Basic Blacks'],
    temperature: ['Temperature', 'Temperatura', 'Farbtemperatur', 'Temp'],
    tint:        ['Tint', 'Matiz', 'Tonung', 'Tonwert', 'Tinte'],
    saturation:  ['Saturation', 'Saturação', 'Sättigung', 'Saturacion', 'Sat'],
    vibrance:    ['Vibrance', 'Vibração', 'Dynamik', 'Intensidad']
};

function mcSetProp(lumetri, names, value) {
    try {
        for (var i = 0; i < lumetri.properties.numItems; i++) {
            var p = lumetri.properties[i];
            var dn = (p.displayName || p.name || '').toLowerCase();
            for (var n = 0; n < names.length; n++) {
                var target = names[n].toLowerCase();
                if (dn === target || dn.indexOf(target) >= 0) {
                    try { p.setValue(value, true); return true; } catch (e) {
                        try { p.setValue(value); return true; } catch (e2) {
                            try { p.setValue(Number(value)); return true; } catch (e3) { return false; }
                        }
                    }
                }
            }
        }
    } catch (e) {}
    return false;
}

/**
 * Aplica os parâmetros calculados nos clipes selecionados.
 * Devolve quantos clipes receberam e quantas propriedades falharam.
 */
function applyColorGrade(paramsJson) {
    try {
        var params = mcParse(paramsJson);
        if (!params || !params.basic) return mcErr('parâmetros inválidos');

        var r = mcSelection();
        if (r.err) return mcErr(r.err);

        var applied = 0, missed = 0, noLumetri = 0;

        for (var i = 0; i < r.clips.length; i++) {
            var clip = r.clips[i];
            var lum = mcFindLumetri(clip);
            if (!lum) lum = mcAddLumetri(clip);
            if (!lum) { noLumetri++; continue; }

            for (var key in MC_MAP) {
                if (!MC_MAP.hasOwnProperty(key)) continue;
                if (params.basic[key] === undefined) continue;
                if (!mcSetProp(lum, MC_MAP[key], params.basic[key])) missed++;
            }
            applied++;
        }

        if (!applied) return mcErr('Adicione o efeito Lumetri Color no clipe da timeline');
        return mcJSON({ ok: true, count: applied, missed: missed, noLumetri: noLumetri });
    } catch (e) { return mcErr(e); }
}

/** Devolve tudo ao neutro nos clipes selecionados. */
function resetColorGrade() {
    try {
        var r = mcSelection();
        if (r.err) return mcErr(r.err);

        var neutral = {
            exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0,
            blacks: 0, temperature: 0, tint: 0, saturation: 100, vibrance: 0
        };
        var done = 0;
        for (var i = 0; i < r.clips.length; i++) {
            var lum = mcFindLumetri(r.clips[i]);
            if (!lum) continue;
            for (var key in MC_MAP) {
                if (!MC_MAP.hasOwnProperty(key)) continue;
                mcSetProp(lum, MC_MAP[key], neutral[key]);
            }
            done++;
        }
        if (!done) return mcErr('nenhum Lumetri para resetar');
        return mcJSON({ ok: true, count: done });
    } catch (e) { return mcErr(e); }
}

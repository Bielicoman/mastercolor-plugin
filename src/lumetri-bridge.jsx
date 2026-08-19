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

var MC_LUMETRI_NAMES = ['Lumetri Color', 'Cor Lumetri', 'Lumetri-Farbe', 'Couleur Lumetri', 'Color Lumetri'];

function mcIsLumetri(name) {
    if (!name) return false;
    for (var i = 0; i < MC_LUMETRI_NAMES.length; i++) {
        if (name === MC_LUMETRI_NAMES[i]) return true;
    }
    return name.indexOf('Lumetri') >= 0;
}

function mcFindLumetri(clip) {
    try {
        for (var i = 0; i < clip.components.numItems; i++) {
            if (mcIsLumetri(clip.components[i].displayName)) return clip.components[i];
        }
    } catch (e) {}
    return null;
}

function mcAddLumetri(clip) {
    try {
        if (typeof qe === 'undefined' || !qe) app.enableQE();
        var seq = mcSeq();
        var qseq = qe.project.getActiveSequence();
        for (var v = 0; v < qseq.numVideoTracks; v++) {
            var qtr = qseq.getVideoTrackAt(v);
            for (var c = 0; c < qtr.numItems; c++) {
                var qc = qtr.getItemAt(c);
                if (qc && qc.name === clip.name) {
                    qc.addVideoEffect(qe.project.getVideoEffectByName('Lumetri Color'));
                    return mcFindLumetri(clip);
                }
            }
        }
    } catch (e) {}
    return null;
}

/** Mapa: chave do painel -> nomes possíveis da propriedade no Lumetri. */
var MC_MAP = {
    exposure:    ['Exposure', 'Exposição', 'Belichtung'],
    contrast:    ['Contrast', 'Contraste', 'Kontrast'],
    highlights:  ['Highlights', 'Realces', 'Lichter'],
    shadows:     ['Shadows', 'Sombras', 'Tiefen'],
    whites:      ['Whites', 'Brancos', 'Weiß'],
    blacks:      ['Blacks', 'Pretos', 'Schwarz'],
    temperature: ['Temperature', 'Temperatura', 'Farbtemperatur'],
    tint:        ['Tint', 'Matiz', 'Tonung', 'Tonwert'],
    saturation:  ['Saturation', 'Saturação', 'Sättigung'],
    vibrance:    ['Vibrance', 'Vibração', 'Dynamik']
};

function mcSetProp(lumetri, names, value) {
    try {
        for (var i = 0; i < lumetri.properties.numItems; i++) {
            var p = lumetri.properties[i];
            var dn = p.displayName;
            for (var n = 0; n < names.length; n++) {
                if (dn === names[n]) {
                    try { p.setValue(value, true); return true; } catch (e) {
                        try { p.setValue(value); return true; } catch (e2) { return false; }
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

        if (!applied) return mcErr('não achei o Lumetri Color nos clipes');
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

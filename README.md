# Master Color

**Reference color match para Adobe Premiere Pro.**

Mede o seu clipe e um frame de referência e escreve a diferença entre os dois
no Lumetri Color. Referência quente deixa o clipe quente — ele casa o look,
não neutraliza a imagem.

## Como funciona

1. Amostra até 4.000 pixels de cada imagem
2. sRGB linearizado → XYZ (D65) → CIE L\*a\*b\*
3. Estatísticas por zona tonal (sombras / meios / altas) e percentis de luminância
4. A diferença entre os dois perfis vira Exposição, Contraste, Realces, Sombras,
   Brancos, Pretos, Temperatura, Matiz, Saturação, Vibração e as três rodas de cor
5. Força de 0 a 100%, amortecimento em tons de pele e trava anti-clipping

## Instalação

Baixe o `MasterColor.zxp` e abra no [ZXP Installer](https://zxpinstaller.com/).
Depois: **Janela → Extensões → Master Color**.

Instalado uma vez, o painel se mantém atualizado sozinho.

## Testes

```bash
node tests/engine.test.js
```

Rodam sem o Premiere e sem internet.

## Estrutura

```
src/color-engine.js     matemática pura, sem Premiere e sem DOM
src/panel.js            interface do painel
src/lumetri-bridge.jsx  ponte ExtendScript
js/ascencio-updater.js  atualização automática
website/                site, carrega o mesmo color-engine.js
```

---

MIT · Alex Ascencio

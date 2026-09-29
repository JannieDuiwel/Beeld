'use strict';
/**
 * Prompt presets.
 *
 * These exist because the difference between a bad render and a good one is
 * usually vocabulary, not settings - and that vocabulary is not obvious if you
 * have not done this before. Each preset is a suffix appended to whatever the
 * user typed, never a replacement for it.
 *
 * Keep them short. Long keyword soups ("8k, masterpiece, trending on artstation")
 * were an SD 1.5 habit and actively hurt on FLUX-class models, which follow
 * plain descriptive language better.
 */

const PRESETS = [
  {
    id: 'none',
    label: 'No preset',
    suffix: '',
    hint: 'Just your prompt, nothing appended.',
  },
  {
    id: 'archviz-day',
    label: 'Architecture — daylight',
    suffix:
      'architectural photograph, natural daylight, soft shadows, clear sky, ' +
      'realistic materials, landscaped surroundings, shot on a 35mm lens',
    hint: 'Neutral midday exterior. The safe default for a massing model.',
  },
  {
    id: 'archviz-dusk',
    label: 'Architecture — dusk',
    suffix:
      'architectural photograph at dusk, warm interior lights glowing through ' +
      'windows, deep blue sky, wet ground reflections, long exposure',
    hint: 'The estate-agent shot. Flatters almost any building.',
  },
  {
    id: 'archviz-sketch',
    label: 'Architecture — concept sketch',
    suffix:
      'loose architectural concept sketch, ink linework with light watercolour ' +
      'wash, white background, hand drawn',
    hint: 'Goes the other way: makes a clean model look hand-drawn.',
  },
  {
    id: 'product',
    label: 'Product photo',
    suffix:
      'product photograph, seamless studio background, soft boxed lighting, ' +
      'shallow depth of field, crisp detail',
    hint: 'Clean studio look for objects.',
  },
  {
    id: 'photo',
    label: 'Photographic',
    suffix:
      'photograph, natural lighting, realistic detail, shallow depth of field',
    hint: 'Generic nudge towards realism for anything that is not a building.',
  },
  {
    id: 'illustration',
    label: 'Illustration',
    suffix:
      'clean vector illustration, flat colour, bold shapes, minimal detail',
    hint: 'Flat graphic style.',
  },
  {
    id: 'game-pixel',
    label: 'Game — pixel art',
    suffix:
      'pixel art style, crisp hard edges, limited colour palette, no anti-aliasing, ' +
      'no gradients, no blur, flat shading',
    hint: 'Generate, then use Tools > Pixelate to snap it to a true low-res grid.',
  },
  {
    id: 'game-sprite',
    label: 'Game — sprite (cut-out ready)',
    suffix:
      'single game sprite, centred, full subject visible, on a plain flat solid magenta ' +
      '(#FF00FF) background, no shadow on background, no text',
    hint: 'Flat magenta backdrop so Tools > Cut out can make it transparent.',
  },
  {
    id: 'game-icon',
    label: 'Game — icon',
    suffix:
      'clean game UI icon, centred, bold readable silhouette, on a plain flat solid ' +
      'magenta (#FF00FF) background',
    hint: 'Item and ability icons. Cut out, then pixelate small.',
  },
  {
    id: 'game-tile',
    label: 'Game — seamless tile',
    suffix:
      'seamless tileable texture, top-down, flat even lighting, no borders, no vignette',
    hint: 'Ground and wall textures. Check the edges line up before using.',
  },
];

/** Joins a user prompt and a preset without doubling punctuation. */
function applyPreset(prompt, presetId) {
  const preset = PRESETS.find((p) => p.id === presetId);
  const base = String(prompt || '').trim();
  if (!preset || !preset.suffix) return base;
  if (!base) return preset.suffix;
  const sep = /[.,;]$/.test(base) ? ' ' : ', ';
  return base + sep + preset.suffix;
}

module.exports = { PRESETS, applyPreset };

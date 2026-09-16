'use strict';
/**
 * Diffs the model catalogue in src/shared/models.js against Replicate's live
 * schemas.
 *
 * This exists because the catalogue hardcodes input field names, and the
 * failure mode when one drifts is a 422 with no hint about which field was
 * wrong. Running this turns that latent risk into a one-command check.
 *
 *   REPLICATE_API_TOKEN=r8_... npm run check-models
 *
 * The token is read from the environment rather than the app's key store: this
 * is a developer tool and should not need Electron booted to run.
 */

const { REPLICATE_MODELS } = require('../src/shared/models');
const replicate = require('../src/main/providers/replicate');

const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;

async function main() {
  if (!token) {
    console.error('Set REPLICATE_API_TOKEN first. Get one at https://replicate.com/account/api-tokens');
    process.exit(2);
  }

  let bad = 0;

  for (const model of REPLICATE_MODELS) {
    process.stdout.write(`${model.id}\n`);
    let live;
    try {
      live = await replicate.fetchSchema({ key: token, modelId: model.id });
    } catch (e) {
      console.log(`  ! could not fetch schema: ${e.message}\n`);
      bad++;
      continue;
    }

    const problems = [];

    if (model.imageField && !live.fields.includes(model.imageField)) {
      problems.push(
        `image field "${model.imageField}" is gone. Live fields: ${live.fields.join(', ')}`,
      );
    }

    for (const name of model.controls || []) {
      if (name === 'seed') continue;
      if (!live.fields.includes(name)) problems.push(`control "${name}" not in the live schema`);
    }

    for (const name of Object.keys(model.defaults || {})) {
      if (!live.fields.includes(name)) problems.push(`default "${name}" not in the live schema`);
    }

    const liveIsArray = live.outputType === 'array';
    if (live.outputType && liveIsArray !== Boolean(model.outputIsArray)) {
      problems.push(
        `outputIsArray is ${Boolean(model.outputIsArray)} but the live output type is "${live.outputType}"`,
      );
    }

    if (problems.length) {
      bad++;
      for (const p of problems) console.log(`  ! ${p}`);
    } else {
      console.log(`  ok — ${live.fields.length} fields, output ${live.outputType || 'unknown'}`);
    }
    console.log('');
  }

  if (bad) {
    console.log(`${bad} model(s) need attention in src/shared/models.js.`);
    process.exit(1);
  }
  console.log('Catalogue matches every live schema.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

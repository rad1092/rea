#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { checkPin, runtimeFiles } from '../lib/attestation.mjs';
import { PIN } from '../lib/sandbox.mjs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node attest-runtime.mjs PINNED_SOURCE NEW_MANIFEST');
const root = await fs.realpath(input);
const revision=checkPin(root);
await fs.writeFile(output, JSON.stringify({commit:PIN,revision,node:process.version,build:'typescript-termux 5.9.3: tsc -p tsconfig.build.json (no lifecycle/optional)',files:await runtimeFiles(root)},null,2)+'\n', {flag:'wx',mode:0o600});

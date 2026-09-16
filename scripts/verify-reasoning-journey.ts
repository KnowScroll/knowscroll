import {readFile} from 'node:fs/promises';
import {verifyReasoningJourney} from './reasoning-journey-verifier.ts';
const path = process.argv[2];
if (!path) throw new Error('Usage: verify-reasoning-journey.ts <J004 receipt path>');
console.log(JSON.stringify(verifyReasoningJourney(JSON.parse(await readFile(path, 'utf8')))));

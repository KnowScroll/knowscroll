import {z} from 'zod';
import {writeFile} from 'node:fs/promises';
import {exposureInput,interactionInput} from '../packages/contracts/src/index.ts';
await writeFile('packages/contracts/http-v1.schema.json',JSON.stringify({contractVersion:1,exposure:z.toJSONSchema(exposureInput),interaction:z.toJSONSchema(interactionInput)},null,2)+'\n');

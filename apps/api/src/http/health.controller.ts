import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Kysely } from 'kysely';
import { apiContract } from '@knowscroll/contracts';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import { readLatestMigration } from '@knowscroll/backend/infrastructure/postgres';
import { API_CONFIG, DATABASE } from '../tokens.js';

/**
 * `GET /health`: release identity for deploy checks. Reads the newest applied migration, so a
 * 200 also proves the database answers.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly db: Kysely<unknown>,
  ) {}

  @Implement(apiContract.health)
  health() {
    return implement(apiContract.health).handler(async () => ({
      status: 'ok' as const,
      world: this.config.world,
      commit: this.config.commit,
      artifact: this.config.artifactSha256,
      migration: await readLatestMigration(this.db),
    }));
  }
}

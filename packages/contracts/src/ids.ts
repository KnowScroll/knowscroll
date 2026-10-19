import { z } from 'zod';

/** Public IDs are UUIDs (UUIDv7 when the server mints them). A client-generated command ID is any UUID. */
export const UuidSchema = z.uuid();

export const CommandIdSchema = UuidSchema;
export const AssetIdSchema = UuidSchema;
export const UniverseIdSchema = UuidSchema;

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "./config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });
export const db = drizzle(pool, { schema });
export type Db = typeof db;

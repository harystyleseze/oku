import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./db.js";

// Applies every SQL file under apps/api/drizzle that has not run yet.
const here = path.dirname(fileURLToPath(import.meta.url));
await migrate(db, { migrationsFolder: path.resolve(here, "../drizzle") });
console.log("Database is up to date.");
await pool.end();

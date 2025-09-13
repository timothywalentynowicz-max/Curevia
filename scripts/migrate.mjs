import { ensureMigrations } from "../src/db.mjs";

await ensureMigrations();
console.log("Migrations applied.");


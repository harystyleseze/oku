import http from "node:http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { attachUser } from "./auth.js";
import { router } from "./routes.js";
import { attachSignaling } from "./signaling.js";
import { resumeInterruptedJobs } from "./queue.js";
import { pool } from "./db.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: config.webOrigins, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(attachUser);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/", router);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong on the server." });
});

const server = http.createServer(app);
attachSignaling(server);

server.listen(config.port, async () => {
  console.log(`Oku API listening on http://localhost:${config.port} (storage: ${config.storage.driver})`);
  try {
    await resumeInterruptedJobs();
  } catch (err) {
    console.error("Could not resume interrupted jobs:", err);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await pool.end();
    process.exit(0);
  });
}

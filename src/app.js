import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth.js";
import parentRoutes from "./routes/parent.js";
import catalogRoutes from "./routes/catalog.js";
import learnRoutes from "./routes/learn.js";
import studioRoutes from "./routes/studio.js";
import studioAiRoutes from "./routes/studioAi.js";
import practiceRoutes from "./routes/practice.js";

export function createApp() {
  const app = express();
  // Derrière un proxy (hébergeur, Nginx) : TRUST_PROXY=1 pour que les limiteurs voient la vraie IP du visiteur
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp);
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") ?? true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRoutes);
  app.use("/parent", parentRoutes);
  app.use("/studio", studioRoutes);
  app.use("/studio", studioAiRoutes);
  app.use("/practice", practiceRoutes);
  app.use("/", catalogRoutes);
  app.use("/", learnRoutes);

  app.use((req, res) => res.status(404).json({ error: "Route introuvable" }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Erreur interne" });
  });
  return app;
}

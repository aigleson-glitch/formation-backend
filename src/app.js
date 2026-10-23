import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth.js";
import parentRoutes from "./routes/parent.js";
import catalogRoutes from "./routes/catalog.js";
import learnRoutes from "./routes/learn.js";
import studioRoutes from "./routes/studio.js";
import studioAiRoutes from "./routes/studioAi.js";
import studioQuizRoutes from "./routes/studioQuiz.js";
import quizRoutes from "./routes/quiz.js";
import practiceRoutes from "./routes/practice.js";
import adminRoutes from "./routes/admin.js";
import studioAssignmentRoutes from "./routes/studioAssignment.js";
import assignmentRoutes from "./routes/assignment.js";
import parentSubmissionRoutes from "./routes/parentSubmissions.js";

export function createApp() {
  const app = express();
  // Derrière un proxy (hébergeur, Nginx) : TRUST_PROXY=1 pour que les limiteurs voient la vraie IP du visiteur
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp);
  app.use(helmet());
  // En production, CORS_ORIGIN est obligatoire (vérifié au démarrage) ; en développement, toutes les origines sont acceptées.
  const origins = (process.env.CORS_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRoutes);
  app.use("/parent", parentRoutes);
  app.use("/parent", parentSubmissionRoutes);
  app.use("/admin", adminRoutes);
  app.use("/studio", studioRoutes);
  app.use("/studio", studioAiRoutes);
  // Les devoirs avant les quiz : leur garde empêche de modifier un devoir par les routes de quiz
  app.use("/studio", studioAssignmentRoutes);
  app.use("/studio", studioQuizRoutes);
  app.use("/practice", practiceRoutes);
  app.use("/", catalogRoutes);
  app.use("/", quizRoutes);
  app.use("/", assignmentRoutes);
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

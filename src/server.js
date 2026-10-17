import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET manquant dans .env");
  process.exit(1);
}
const port = process.env.PORT || 3000;
createApp().listen(port, () => console.log(`API sur http://localhost:${port}`));

// Purge horaire des séances d'entraînement expirées (confidentialité : pas de conservation inutile)
setInterval(
  () => prisma.practiceSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch((e) => console.error("Purge :", e.message)),
  60 * 60 * 1000
).unref();

for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
  if (!process.env[k]) console.warn(`${k} absent : l'entraînement oral IA sera indisponible.`);
}

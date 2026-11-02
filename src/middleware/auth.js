import { prisma } from "../lib/prisma.js";
import { syncAgeGroup, verifyToken } from "../lib/auth.js";

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentification requise" });

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: "Jeton invalide ou expiré" });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) return res.status(401).json({ error: "Compte inactif ou introuvable" });
    req.user = await syncAgeGroup(user);
    next();
  } catch (error) {
    next(error);
  }
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Accès refusé" });

// Le parent agit pour un enfant uniquement via un lien actif (règles 11 et 13)
export async function isActiveGuardian(parentId, childId) {
  const g = await prisma.guardianship.findFirst({
    where: { parentId, childId, status: "active", child: { ageGroup: { in: ["child", "teen"] } } },
  });
  return !!g;
}

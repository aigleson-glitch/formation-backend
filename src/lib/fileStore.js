import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';

// Rangement des fichiers sur le disque du serveur, sous un nom aléatoire (jamais le nom de l'utilisateur).
// Pour un hébergeur qui efface le disque à chaque déploiement, remplacer ce fichier par un stockage externe (S3) :
// le reste du code n'appelle que ces quatre fonctions.
export const uploadDir = () => path.resolve(process.env.UPLOAD_DIR || 'uploads');
const KEY = /^[0-9a-f]{32}$/;
const pathOf = (key) => {
  if (!KEY.test(key)) throw new Error('Clé de stockage invalide');
  return path.join(uploadDir(), key);
};

export async function saveBytes(buffer) {
  const key = randomUUID().replaceAll('-', '');
  await fs.mkdir(uploadDir(), { recursive: true });
  await fs.writeFile(pathOf(key), buffer, { flag: 'wx', mode: 0o600 });
  return key;
}

export const openStream = (key) => createReadStream(pathOf(key));
export const removeBytes = (key) => fs.rm(pathOf(key), { force: true });
export async function exists(key) {
  try { await fs.access(pathOf(key)); return true; } catch { return false; }
}

// Un fichier envoyé mais jamais rattaché à une remise est supprimé au bout de 24 h.
// Appelé à chaque envoi, au plus une fois toutes les 10 minutes.
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
let lastCleanup = 0;
export async function cleanupOrphans(now = Date.now()) {
  if (now - lastCleanup < 10 * 60 * 1000) return 0;
  lastCleanup = now;
  try {
    const old = await prisma.submissionFile.findMany({
      where: { submissionId: null, createdAt: { lt: new Date(now - ORPHAN_AGE_MS) } },
      select: { id: true, storageKey: true },
      take: 200,
    });
    for (const f of old) {
      await removeBytes(f.storageKey).catch(() => {});
      await prisma.submissionFile.deleteMany({ where: { id: f.id, submissionId: null } });
    }
    return old.length;
  } catch (e) {
    console.error('Nettoyage des fichiers orphelins :', e.message);
    return 0;
  }
}

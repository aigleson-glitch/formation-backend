import { randomInt } from 'node:crypto';
import { prisma } from './prisma.js';

// Certificats de fin de formation (un par inscription terminée).
// Code public : 12 caractères tirés au hasard (alphabet sans 0/O/1/I/L), affichés par groupes de 4, ex. CERT-7KQ2-M9XD-4TFH.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_PATTERN = /^CERT-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

export function generateCode() {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `CERT-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Saisie tolérante (minuscules, espaces, tirets manquants) → forme canonique, ou null si le format est impossible. */
export function normalizeCode(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('CERT') ? raw.slice(4) : raw;
  if (body.length !== 12) return null;
  const code = `CERT-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
  return CODE_PATTERN.test(code) ? code : null;
}

/**
 * Nom montré sur la page publique de vérification : complet pour un adulte, prénom + initiale pour un mineur
 * (la page est ouverte à tous, sans connexion).
 */
export function publicHolderName(user) {
  const first = user.firstName.trim();
  const last = user.lastName.trim();
  if (user.ageGroup === 'adult') return `${first} ${last}`;
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

/** Émet le certificat d'une inscription terminée (sans effet si elle n'est pas terminée ou s'il existe déjà). */
export async function issueCertificate(enrollmentId) {
  const e = await prisma.enrollment.findUnique({
    where: { id: enrollmentId }, select: { id: true, status: true, completedAt: true, certificate: { select: { id: true } } },
  });
  if (!e || e.status !== 'completed') return null;
  if (e.certificate) return e.certificate;
  for (let i = 0; i < 5; i++) {
    try {
      return await prisma.certificate.create({ data: { enrollmentId: e.id, code: generateCode(), issuedAt: e.completedAt ?? new Date() } });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
      // Conflit : soit un autre processus vient d'émettre ce certificat, soit le code existe déjà (très improbable)
      const existing = await prisma.certificate.findUnique({ where: { enrollmentId: e.id } });
      if (existing) return existing;
    }
  }
  throw new Error('Impossible de générer un code de certificat unique');
}

/** Rattrapage : les formations terminées avant l'arrivée des certificats en reçoivent un à la première consultation. */
export async function ensureCertificates(userId) {
  const missing = await prisma.enrollment.findMany({ where: { userId, status: 'completed', certificate: null }, select: { id: true } });
  for (const m of missing) await issueCertificate(m.id);
}

/** Forme renvoyée à l'élève ou au parent : tout ce qu'il faut pour afficher et imprimer le certificat. */
export function certificateView(cert, enrollment, user, course) {
  const base = process.env.CERTIFICATE_VERIFY_BASE_URL;
  return {
    code: cert.code,
    issuedAt: cert.issuedAt,
    completedAt: enrollment.completedAt,
    holder: { firstName: user.firstName, lastName: user.lastName },
    course: { id: course.id, title: course.title, slug: course.slug },
    issuer: process.env.CERTIFICATE_ISSUER_NAME || 'Plateforme de formation',
    verifyPath: `/certificates/verify/${cert.code}`,
    ...(base && { verifyUrl: `${base.replace(/\/+$/, '')}/${cert.code}` }),
  };
}

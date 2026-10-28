// Règles des fichiers joints aux copies : type réel (lu dans le contenu, pas déclaré par le navigateur), taille, nom.
// Pures : aucune lecture de disque ni de base, donc testables seules.

export const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024;
export const MAX_PENDING_FILES = 5; // fichiers envoyés mais pas encore rattachés à une remise, par élève et par devoir

// Signatures (premiers octets) → type réel. L'extension du nom doit correspondre au contenu détecté.
const TYPES = [
  { mime: 'application/pdf', exts: ['pdf'], magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: 'image/png', exts: ['png'], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', exts: ['jpg', 'jpeg'], magic: [0xff, 0xd8, 0xff] },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: ['docx'], magic: [0x50, 0x4b, 0x03, 0x04] }, // zip
  { mime: 'application/zip', exts: ['zip'], magic: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/msword', exts: ['doc'], magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

export const ALLOWED_EXTENSIONS = TYPES.flatMap((t) => t.exts);

const startsWith = (buf, magic) => buf.length >= magic.length && magic.every((b, i) => buf[i] === b);
export const extensionOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] ?? '';

/** Nom d'affichage sûr : sans chemin, sans caractères de contrôle, 150 caractères au plus. */
export function safeFileName(raw) {
  let name = String(raw ?? '');
  try { name = decodeURIComponent(name); } catch { /* nom déjà décodé ou invalide : on le garde tel quel */ }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  if (name.length > 150) {
    const ext = extensionOf(name);
    name = name.slice(0, 150 - (ext ? ext.length + 1 : 0)) + (ext ? `.${ext}` : '');
  }
  return name;
}

/**
 * Valide un fichier reçu. Retourne { ok: true, mime, name } ou { ok: false, status, message }.
 * Le type vient du contenu : un « .pdf » qui n'en est pas un est refusé, quoi que déclare le navigateur.
 */
export function checkUpload({ buffer, fileName }) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, status: 415, message: 'Envoyez le fichier brut (Content-Type: application/octet-stream)' };
  if (buffer.length === 0) return { ok: false, status: 422, message: 'Le fichier est vide' };
  if (buffer.length > MAX_UPLOAD_BYTES) return { ok: false, status: 413, message: `Fichier trop volumineux (${Math.round(MAX_UPLOAD_BYTES / 1048576)} Mo au maximum)` };
  const name = safeFileName(fileName);
  if (!name) return { ok: false, status: 422, message: 'Le nom du fichier est obligatoire' };
  const ext = extensionOf(name);
  const type = TYPES.find((t) => t.exts.includes(ext));
  if (!type) return { ok: false, status: 415, message: 'Type de fichier non accepté (PDF, Word, image PNG ou JPEG, ZIP)' };
  if (!startsWith(buffer, type.magic)) return { ok: false, status: 415, message: 'Le contenu du fichier ne correspond pas à son extension' };
  return { ok: true, mime: type.mime, name };
}

/** Nom de téléchargement : ASCII de repli + version UTF-8 (accents), jamais « inline ». */
export function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export const fileView = (f) => (f ? { id: f.id, name: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes } : null);

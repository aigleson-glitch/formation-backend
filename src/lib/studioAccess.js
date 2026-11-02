import { prisma } from './prisma.js';
import { HttpError } from './http.js';
import { UUID_RE } from './chapterProfile.js';

export async function assertOwnsCourse(user, courseId) {
  if (!UUID_RE.test(String(courseId))) throw new HttpError(404, 'Formation introuvable');
  const course = await prisma.course.findUnique({ where: { id: courseId }, include: { audiences: true } });
  if (!course) throw new HttpError(404, 'Formation introuvable');
  if (user.role === 'admin') return course;
  const link = await prisma.courseInstructor.findUnique({ where: { courseId_userId: { courseId, userId: user.id } } });
  if (!link) throw new HttpError(403, 'Cette formation ne vous est pas affectée');
  return course;
}

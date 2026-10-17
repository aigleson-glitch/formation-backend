export const validate = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: "Données invalides", details: r.error.flatten().fieldErrors });
  req.body = r.data;
  next();
};

// Consistent success envelope. List endpoints attach `meta` for pagination.
export function ok(res, data, meta) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.json(body);
}

export function created(res, data) {
  return res.status(201).json({ success: true, data });
}

// Build pagination meta from query params + total count.
export function paginate(query, total) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    skip: (page - 1) * limit,
  };
}

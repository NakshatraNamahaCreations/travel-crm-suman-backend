import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

const phone = z.object({
  countryCode: z.string().default('91'),
  number: z.string().min(4),
  isPrimary: z.boolean().optional(),
});

export const createQuerySchema = z.object({
  source: objectId.optional(),
  referenceId: z.string().optional(),
  salesTeam: objectId.optional(),
  tags: z.array(objectId).optional(),

  destinations: z.array(objectId).optional(),
  startDate: z.coerce.date().optional(),
  nights: z.coerce.number().int().min(0).optional(),
  pax: z
    .object({
      adults: z.coerce.number().int().min(1).default(1),
      children: z.array(z.object({ age: z.coerce.number().int().min(0).max(17) })).optional(),
    })
    .optional(),
  foc: z.coerce.number().min(0).optional(),

  guest: z
    .object({
      salutation: z.string().optional(),
      name: z.string().optional(),
      email: z.string().email().optional().or(z.literal('')),
      location: z.string().optional(),
      nationality: z.string().optional(),
      phones: z.array(phone).optional(),
    })
    .optional(),

  comments: z.string().optional(),
  owner: objectId.optional(),
  status: z.string().optional(),
});

// Update reuses the same shape, all optional.
export const updateQuerySchema = createQuerySchema.partial();

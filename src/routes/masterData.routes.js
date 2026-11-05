import { Destination } from '../models/Destination.js';
import { QuerySource } from '../models/QuerySource.js';
import { Tag } from '../models/Tag.js';
import { InclusionExclusion } from '../models/InclusionExclusion.js';
import { crudFactory } from '../utils/crudFactory.js';
import { makeCrudRouter } from './_crudRouter.js';

// Sales reps may create destinations/sources/tags on the fly from the query form.
const openWrite = { perm: 'masterdata' };

export const destinationRoutes = makeCrudRouter(
  crudFactory(Destination, { searchFields: ['name', 'country', 'region'], filterFields: ['region'], sort: 'name' }),
  { perm: 'masterdata' }
);

export const querySourceRoutes = makeCrudRouter(crudFactory(QuerySource), openWrite);

export const tagRoutes = makeCrudRouter(
  crudFactory(Tag, { beforeWrite: (body) => ({ ...body, name: String(body.name).toLowerCase().trim() }) }),
  openWrite
);

export const inclusionExclusionRoutes = makeCrudRouter(
  crudFactory(InclusionExclusion, { searchFields: ['text'], filterFields: ['type'], sort: '-type order createdAt' }),
  { perm: 'masterdata' }
);

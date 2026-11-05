import { Team } from '../models/Team.js';
import { crudFactory } from '../utils/crudFactory.js';
import { makeCrudRouter } from './_crudRouter.js';

export const teamRoutes = makeCrudRouter(
  crudFactory(Team, { searchFields: ['name', 'description'] }),
  { perm: 'teams' }
);

import { City } from '../models/City.js';
import { State } from '../models/State.js';
import { crudFactory } from '../utils/crudFactory.js';
import { makeCrudRouter } from './_crudRouter.js';

const W = { perm: 'masterdata' };
const stampCreator = (req) => ({ createdBy: req.user._id });

export const stateRoutes = makeCrudRouter(
  crudFactory(State, {
    searchFields: ['name', 'country'],
    sort: 'name',
    injectOnCreate: stampCreator,
  }),
  W
);

export const cityRoutes = makeCrudRouter(
  crudFactory(City, {
    searchFields: ['name'],
    populate: [{ path: 'state', select: 'name country' }],
    filterFields: ['state'],
    sort: 'name',
    injectOnCreate: stampCreator,
  }),
  W
);

import { Router } from 'express';
import { protect, authorize, can } from '../middleware/auth.js';

/**
 * Wires a crudFactory object onto a router.
 * Reads require auth. Writes are gated by fine-grained permissions when a
 * `perm` module key is given (e.g. perm: 'hotels' → hotels.create/edit/delete),
 * otherwise they fall back to role-based `writeRoles` (default admin/manager).
 */
export function makeCrudRouter(crud, { writeRoles = ['admin', 'manager'], perm } = {}) {
  const router = Router();
  const createGuard = perm ? can(`${perm}.create`) : authorize(...writeRoles);
  const editGuard = perm ? can(`${perm}.edit`) : authorize(...writeRoles);
  const deleteGuard = perm ? can(`${perm}.delete`) : authorize(...writeRoles);

  router.use(protect);
  router.get('/', crud.list);
  router.get('/:id', crud.get);
  router.post('/', createGuard, crud.create);
  router.put('/:id', editGuard, crud.update);
  router.delete('/:id', deleteGuard, crud.remove);

  return router;
}

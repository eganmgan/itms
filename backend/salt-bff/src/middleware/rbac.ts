import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../types/index.js';

type Capability = 'run' | 'scriptAuthor' | 'windowManage' | 'delete' | 'usersManage';

const capabilityMap: Record<Capability, Role[]> = {
  run: ['admin', 'operator'],
  scriptAuthor: ['admin', 'operator'],
  windowManage: ['admin', 'operator'],
  delete: ['admin'],
  usersManage: ['admin'],
};

export function requireCapability(capability: Capability) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !capabilityMap[capability].includes(role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}

export function permissionsByRole(role: Role) {
  return {
    runJobs: capabilityMap.run.includes(role),
    authorScripts: capabilityMap.scriptAuthor.includes(role),
    manageWindows: capabilityMap.windowManage.includes(role),
    deleteResources: capabilityMap.delete.includes(role),
    manageUsers: capabilityMap.usersManage.includes(role),
  };
}

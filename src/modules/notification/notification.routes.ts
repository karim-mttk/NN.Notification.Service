import { Router } from 'express';
import controller from './notification.controller';
import { authenticate, requireTenant } from '@/middleware/jwtAuth';

const router = Router();

router.use(authenticate, requireTenant);

router.get('/', (req, res) => controller.list(req, res));
router.get('/unread-count', (req, res) => controller.unreadCount(req, res));
router.patch('/read-all', (req, res) => controller.markAllRead(req, res));
router.patch('/:id/read', (req, res) => controller.markRead(req, res));

export default router;

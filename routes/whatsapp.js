import express from 'express';
import WhatsAppController from '../controllers/whatsappController.js';

const router = express.Router();

router.post('/session/create', WhatsAppController.createSession);
router.get('/session/qr/:sessionId', WhatsAppController.getQR);
router.get('/session/status/:sessionId', WhatsAppController.getStatus);
router.delete('/session/delete/:sessionId', WhatsAppController.deleteSession);
router.post('/session/logout/:sessionId', WhatsAppController.logoutSession);

router.post('/message/send', WhatsAppController.sendMessage);
router.post('/message/text', WhatsAppController.sendText);
router.post('/message/image', WhatsAppController.sendImage);
router.post('/message/video', WhatsAppController.sendVideo);
router.post('/message/audio', WhatsAppController.sendAudio);
router.post('/message/document', WhatsAppController.sendDocument);
router.post('/message/contact', WhatsAppController.sendContact);

router.get('/sessions/list', WhatsAppController.listSessions);

export default router;
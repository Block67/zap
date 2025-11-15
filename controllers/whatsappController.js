import baileys from '@whiskeysockets/baileys';
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  delay
} = baileys;

import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode';
import chalk from 'chalk';
import axios from 'axios';

class WhatsAppController {
  constructor() {
    this.sessions = new Map();
    this.stores = new Map();
    this.qrCodes = new Map();
    this.retries = new Map();
    this.authDir = path.resolve('./auth_sessions');
    
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    console.log(chalk.green('✅ WhatsApp Controller initialisé'));
  }

  async createSession(req, res) {
    try {
      const { session_id } = req.body;

      if (!session_id) {
        return res.status(400).json({ error: 'session_id requis' });
      }

      if (controller.sessions.has(session_id)) {
        const sock = controller.sessions.get(session_id);
        if (sock?.user) {
          return res.json({ 
            message: 'Session déjà connectée', 
            session_id,
            status: 'connected',
            phone: sock.user.id.split(':')[0]
          });
        }
        return res.json({ 
          message: 'Session existe déjà', 
          session_id,
          status: 'existing'
        });
      }

      console.log(chalk.blue(`📱 Création session: ${session_id}`));

      await controller.initializeSession(session_id, req.app.get('io'));

      res.json({ 
        message: 'Session créée avec succès', 
        session_id,
        status: 'initializing'
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur création session:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async initializeSession(sessionId, io) {
    const sessionPath = path.join(controller.authDir, sessionId);

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    // Ajout d'une gestion d'erreur pour le store (au cas où)
    let store;
    try {
      store = makeInMemoryStore({
        logger: pino().child({ level: 'silent' })
      });
    } catch (storeError) {
      console.error(chalk.red('❌ Erreur création store:'), storeError);
      // Fallback : utiliser un store vide/simple si nécessaire (optionnel)
      store = { bind: () => {} };  // Store minimal pour éviter le crash
      console.warn(chalk.yellow('⚠️ Utilisation d\'un store minimal'));
    }

    controller.stores.set(sessionId, store);

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Chrome (Linux)', '', ''],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 25000,
      emitOwnEvents: true,
      fireInitQueries: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
      // Empêcher les reconnexions automatiques
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
      // Message d'authentification
      qrTimeout: 60000
    });

    store.bind(sock.ev);

    controller.sessions.set(sessionId, sock);

    // Event: QR Code
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrImage = await qrcode.toDataURL(qr);
          controller.qrCodes.set(sessionId, qrImage);
          console.log(chalk.yellow(`📷 QR généré pour ${sessionId}`));
          
          if (io) {
            io.emit(`qr-${sessionId}`, { qr: qrImage });
          }
        } catch (err) {
          console.error(chalk.red('Erreur QR:'), err);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : 500;

        console.log(chalk.red(`❌ Connexion fermée: ${sessionId}`), 
          `Code: ${statusCode}`
        );

        // Codes qui ne doivent PAS reconnecter
        const doNotReconnect = [
          DisconnectReason.loggedOut,        // 401 - Déconnecté manuellement
          DisconnectReason.badSession,       // 400 - Mauvaise session
          DisconnectReason.connectionReplaced // 440 - Remplacé par autre connexion
        ];

        if (doNotReconnect.includes(statusCode)) {
          console.log(chalk.red(`🚫 Session invalide - Code ${statusCode}`));
          controller.cleanupSession(sessionId);
          
          // Supprimer les fichiers d'auth pour forcer nouvelle connexion
          const sessionPath = path.join(controller.authDir, sessionId);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(chalk.yellow(`🗑️ Fichiers d'auth supprimés pour ${sessionId}`));
          }
          return;
        }

        // Tentative de reconnexion pour les autres codes
        const retryCount = controller.retries.get(sessionId) || 0;
        
        if (retryCount < 2) {
          controller.retries.set(sessionId, retryCount + 1);
          console.log(chalk.yellow(`🔄 Tentative ${retryCount + 1}/2 pour ${sessionId}`));
          
          await delay(3000);
          controller.initializeSession(sessionId, io);
        } else {
          console.log(chalk.red(`❌ Échec après ${retryCount} tentatives`));
          controller.cleanupSession(sessionId);
          
          // Nettoyer aussi les fichiers
          const sessionPath = path.join(controller.authDir, sessionId);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        }
      } else if (connection === 'open') {
        console.log(chalk.green(`✅ Session connectée: ${sessionId}`));
        console.log(chalk.green(`📱 Téléphone: ${sock.user?.id}`));
        
        controller.qrCodes.delete(sessionId);
        controller.retries.delete(sessionId);
        
        if (io) {
          io.emit(`connected-${sessionId}`, { 
            status: 'connected',
            phone: sock.user?.id.split(':')[0],
            name: sock.user?.name
          });
        }
      } else if (connection === 'connecting') {
        console.log(chalk.blue(`🔄 Connexion en cours: ${sessionId}`));
      }
    });

    // Event: Credentials Update
    sock.ev.on('creds.update', saveCreds);

    // Event: Messages (pour garder la session active)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(chalk.cyan(`📨 Message reçu pour ${sessionId}`));
    });
  }

  cleanupSession(sessionId) {
    if (controller.sessions.has(sessionId)) {
      const sock = controller.sessions.get(sessionId);
      try {
        sock?.end();
      } catch (err) {
        console.error(chalk.red(`Erreur fermeture socket ${sessionId}:`), err);
      }
      controller.sessions.delete(sessionId);
    }
    
    controller.stores.delete(sessionId);
    controller.qrCodes.delete(sessionId);
    controller.retries.delete(sessionId);
    
    console.log(chalk.yellow(`🧹 Session nettoyée: ${sessionId}`));
  }

  async getQR(req, res) {
    try {
      const { sessionId } = req.params;

      if (!controller.sessions.has(sessionId)) {
        return res.status(404).json({ error: 'Session non trouvée' });
      }

      const qr = controller.qrCodes.get(sessionId);

      if (!qr) {
        const sock = controller.sessions.get(sessionId);
        
        if (sock?.user) {
          return res.json({ 
            status: 'connected',
            message: 'Session déjà connectée',
            phone: sock.user.id.split(':')[0],
            name: sock.user.name
          });
        }

        return res.json({ 
          status: 'waiting',
          message: 'En attente du QR code...' 
        });
      }

      res.json({ 
        qr,
        status: 'qr_ready',
        message: 'Scannez le QR code avec WhatsApp' 
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur QR:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async getStatus(req, res) {
    try {
      const { sessionId } = req.params;

      if (!controller.sessions.has(sessionId)) {
        return res.json({ status: 'disconnected' });
      }

      const sock = controller.sessions.get(sessionId);

      if (sock?.user) {
        return res.json({ 
          status: 'connected',
          phone: sock.user.id.split(':')[0],
          name: sock.user.name
        });
      }

      return res.json({ 
        status: controller.qrCodes.has(sessionId) ? 'qr' : 'pending' 
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur status:'), error);
      res.json({ status: 'error', error: error.message });
    }
  }

  async deleteSession(req, res) {
    try {
      const { sessionId } = req.params;

      if (!controller.sessions.has(sessionId)) {
        return res.status(404).json({ error: 'Session non trouvée' });
      }

      controller.cleanupSession(sessionId);

      const sessionPath = path.join(controller.authDir, sessionId);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      console.log(chalk.yellow(`🗑️ Session supprimée: ${sessionId}`));

      res.json({ message: 'Session supprimée avec succès' });

    } catch (error) {
      console.error(chalk.red('❌ Erreur suppression:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async logoutSession(req, res) {
    try {
      const { sessionId } = req.params;

      if (!controller.sessions.has(sessionId)) {
        return res.status(404).json({ error: 'Session non trouvée' });
      }

      const sock = controller.sessions.get(sessionId);
      
      try {
        await sock.logout();
      } catch (err) {
        console.log(chalk.yellow('Info: Session déjà déconnectée'));
      }

      controller.cleanupSession(sessionId);

      const sessionPath = path.join(controller.authDir, sessionId);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      console.log(chalk.yellow(`👋 Déconnexion: ${sessionId}`));

      res.json({ message: 'Déconnexion réussie' });

    } catch (error) {
      console.error(chalk.red('❌ Erreur logout:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async sendText(req, res) {
    try {
      const { session_id, to, message } = req.body;

      if (!session_id || !to || !message) {
        return res.status(400).json({ 
          error: 'session_id, to et message requis' 
        });
      }

      const sock = controller.sessions.get(session_id);

      if (!sock) {
        return res.status(404).json({ error: 'Session non trouvée' });
      }

      if (!sock.user) {
        return res.status(400).json({ error: 'Session non connectée' });
      }

      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

      const result = await sock.sendMessage(jid, { text: message });

      console.log(chalk.green(`✉️ Message envoyé à ${to}`));

      res.json({ 
        success: true,
        message: 'Message envoyé avec succès',
        messageId: result.key.id
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur envoi:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async sendImage(req, res) {
    try {
      const { session_id, to, image, caption } = req.body;

      if (!session_id || !to || !image) {
        return res.status(400).json({ 
          error: 'session_id, to et image requis' 
        });
      }

      const sock = controller.sessions.get(session_id);

      if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session non connectée' });
      }

      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

      let buffer;
      if (image.startsWith('http')) {
        const response = await axios.get(image, { responseType: 'arraybuffer' });
        buffer = Buffer.from(response.data);
      } else {
        buffer = Buffer.from(image, 'base64');
      }

      const result = await sock.sendMessage(jid, { 
        image: buffer, 
        caption: caption || '' 
      });

      console.log(chalk.green(`🖼️ Image envoyée à ${to}`));

      res.json({ 
        success: true,
        message: 'Image envoyée avec succès',
        messageId: result.key.id
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur image:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async sendVideo(req, res) {
    try {
      const { session_id, to, video, caption } = req.body;

      const sock = controller.sessions.get(session_id);
      if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session non connectée' });
      }

      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

      let buffer;
      if (video.startsWith('http')) {
        const response = await axios.get(video, { responseType: 'arraybuffer' });
        buffer = Buffer.from(response.data);
      } else {
        buffer = Buffer.from(video, 'base64');
      }

      const result = await sock.sendMessage(jid, { 
        video: buffer, 
        caption: caption || '' 
      });

      res.json({ 
        success: true,
        message: 'Vidéo envoyée avec succès',
        messageId: result.key.id
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur vidéo:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async sendAudio(req, res) {
    try {
      const { session_id, to, audio } = req.body;

      const sock = controller.sessions.get(session_id);
      if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session non connectée' });
      }

      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

      let buffer;
      if (audio.startsWith('http')) {
        const response = await axios.get(audio, { responseType: 'arraybuffer' });
        buffer = Buffer.from(response.data);
      } else {
        buffer = Buffer.from(audio, 'base64');
      }

      const result = await sock.sendMessage(jid, { 
        audio: buffer,
        mimetype: 'audio/mp4',
        ptt: true
      });

      res.json({ 
        success: true,
        message: 'Audio envoyé avec succès',
        messageId: result.key.id
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur audio:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async sendDocument(req, res) {
    try {
      const { session_id, to, document, filename } = req.body;

      const sock = controller.sessions.get(session_id);
      if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session non connectée' });
      }

      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

      let buffer;
      if (document.startsWith('http')) {
        const response = await axios.get(document, { responseType: 'arraybuffer' });
        buffer = Buffer.from(response.data);
      } else {
        buffer = Buffer.from(document, 'base64');
      }

      const result = await sock.sendMessage(jid, { 
        document: buffer,
        fileName: filename || 'document.pdf',
        mimetype: 'application/pdf'
      });

      res.json({ 
        success: true,
        message: 'Document envoyé avec succès',
        messageId: result.key.id
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur document:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async sendContact(req, res) {
    try {
      const { session_id, to, contact } = req.body;

      const sock = controller.sessions.get(session_id);
      if (!sock || !sock.user) {
        return res.status(400).json({ error: 'Session non connectée' });
      }

      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

      const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${contact.name}
TEL;type=CELL;type=VOICE;waid=${contact.number}:${contact.number}
END:VCARD`;

      const result = await sock.sendMessage(jid, {
        contacts: {
          displayName: contact.name,
          contacts: [{ vcard }]
        }
      });

      res.json({ 
        success: true,
        message: 'Contact envoyé avec succès',
        messageId: result.key.id
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur contact:'), error);
      res.status(500).json({ error: error.message });
    }
  }

  async sendMessage(req, res) {
    const { type } = req.body;

    switch (type) {
      case 'text':
        return controller.sendText(req, res);
      case 'image':
        return controller.sendImage(req, res);
      case 'video':
        return controller.sendVideo(req, res);
      case 'audio':
        return controller.sendAudio(req, res);
      case 'document':
        return controller.sendDocument(req, res);
      case 'contact':
        return controller.sendContact(req, res);
      default:
        return res.status(400).json({ error: 'Type non supporté' });
    }
  }

  async listSessions(req, res) {
    try {
      const sessions = [];

      for (const [sessionId, sock] of controller.sessions) {
        sessions.push({
          session_id: sessionId,
          status: sock.user ? 'connected' : 'pending',
          phone: sock.user?.id.split(':')[0] || null,
          name: sock.user?.name || null
        });
      }

      res.json({ 
        sessions,
        total: sessions.length 
      });

    } catch (error) {
      console.error(chalk.red('❌ Erreur liste:'), error);
      res.status(500).json({ error: error.message });
    }
  }
}

const controller = new WhatsAppController();

export default controller;
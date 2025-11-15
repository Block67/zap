
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import session from 'express-session';
import flash from 'connect-flash';
import chalk from 'chalk';
import whatsappRoutes from './routes/whatsapp.js';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
  secret: 'whatsapp-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 60000 * 60 * 24 }
}));

app.use(flash());

// Rendre io disponible dans les routes
app.set('io', io);

// Routes
app.use('/', whatsappRoutes);

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'WhatsApp Baileys Server is running',
    timestamp: new Date().toISOString()
  });
});

// Socket.io pour les événements temps réel
io.on('connection', (socket) => {
  console.log(chalk.green('Client connecté:', socket.id));
  
  socket.on('disconnect', () => {
    console.log(chalk.yellow('Client déconnecté:', socket.id));
  });
});

server.listen(PORT, () => {
  console.log(chalk.blue.bold(`
╔════════════════════════════════════════╗
║  🚀 WhatsApp Baileys Server Running    ║
║  📡 Port: ${PORT}                         ║
║  🌐 http://localhost:${PORT}              ║
╚════════════════════════════════════════╝
  `));
});

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { connectDB } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5001;

// Connect to Database
connectDB();

const path = require('path');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware configuration
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: 'http://localhost:4000', credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Routes
const authRoutes = require('./routes/auth');
const oauthRoutes = require('./routes/oauth');

app.use('/oauth', oauthRoutes);
app.use('/', authRoutes);

app.get('/health', (req, res) => {
  res.json({ service: 'auth-service', status: 'ok', port: PORT });
});

app.listen(PORT, () => {
  console.log(`Authorization Server running on http://localhost:${PORT}`);
});

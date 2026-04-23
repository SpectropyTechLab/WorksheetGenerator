const supabase = require('../config/database');
const { signToken, verifyPassword } = require('../utils/auth');

const USERS_TABLE = process.env.USERS_TABLE || 'worksheetgeneratorusers';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

class AuthController {
  static async login(req, res) {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const { data: user, error } = await supabase
        .from(USERS_TABLE)
        .select('id, username, password, role')
        .eq('username', username)
        .single();

      if (error || !user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const ok = verifyPassword(password, user.password);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const secret = process.env.AUTH_SECRET;
      if (!secret) {
        return res.status(500).json({ error: 'AUTH_SECRET not configured' });
      }

      const now = Math.floor(Date.now() / 1000);
      const payload = {
        sub: user.id,
        username: user.username,
        role: user.role,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS
      };

      const token = signToken(payload, secret);

      return res.json({
        success: true,
        token,
        user: { id: user.id, username: user.username, role: user.role }
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Login failed' });
    }
  }
}

module.exports = AuthController;

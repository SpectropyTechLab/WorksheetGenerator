const supabase = require('../config/database');
const { hashPassword } = require('../utils/auth');

const USERS_TABLE = process.env.USERS_TABLE || 'worksheetgeneratorusers';

class UsersController {
  static async list(req, res) {
    try {
      const { data, error } = await supabase
        .from(USERS_TABLE)
        .select('id, username, role, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json({ success: true, users: data });
    } catch (error) {
      console.error('Users list error:', error);
      return res.status(500).json({ error: 'Failed to load users' });
    }
  }

  static async create(req, res) {
    try {
      const { username, password, role } = req.body || {};
      if (!username || !password || !role) {
        return res.status(400).json({ error: 'Username, password, and role are required' });
      }

      const payload = {
        username,
        password: hashPassword(password),
        role
      };

      const { data, error } = await supabase
        .from(USERS_TABLE)
        .insert(payload)
        .select('id, username, role, created_at')
        .single();

      if (error) throw error;
      return res.status(201).json({ success: true, user: data });
    } catch (error) {
      console.error('User create error:', error);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;
      const { username, password, role } = req.body || {};
      if (!id) return res.status(400).json({ error: 'User id required' });

      const updates = {};
      if (username) updates.username = username;
      if (role) updates.role = role;
      if (password) updates.password = hashPassword(password);

      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const { data, error } = await supabase
        .from(USERS_TABLE)
        .update(updates)
        .eq('id', id)
        .select('id, username, role, created_at')
        .single();

      if (error) throw error;
      return res.json({ success: true, user: data });
    } catch (error) {
      console.error('User update error:', error);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  }

  static async remove(req, res) {
    try {
      const { id } = req.params;
      if (!id) return res.status(400).json({ error: 'User id required' });

      const { error } = await supabase
        .from(USERS_TABLE)
        .delete()
        .eq('id', id);

      if (error) throw error;
      return res.json({ success: true });
    } catch (error) {
      console.error('User delete error:', error);
      return res.status(500).json({ error: 'Failed to delete user' });
    }
  }
}

module.exports = UsersController;
